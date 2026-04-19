const { execFile } = require('child_process');
const { query } = require('../config/database');
const logger = require('../utils/logger');

async function queueMessage(target, messageText, notBeforeTs) {
  try {
    // target can be phone E.164 (+xxx) or Telegram chat ID (numeric string)
    const isPhone = target.startsWith('+');
    const channel = isPhone ? 'whatsapp' : 'telegram';
    const phoneVal = isPhone ? target : null;
    const chatIdVal = isPhone ? null : target;

    const res = await query(
      `INSERT INTO outbox_messages (channel, to_phone_e164, to_chat_id, message_text, status, not_before_ts)
       VALUES ($1, $2, $3, $4, 'queued', COALESCE($5, NOW()))
       RETURNING outbox_id`,
      [channel, phoneVal, chatIdVal, messageText, notBeforeTs || null]
    );
    logger.info('Message queued', { outboxId: res.rows[0].outbox_id, channel, target });
    return res.rows[0].outbox_id;
  } catch (err) {
    logger.error('queueMessage failed', { target, err: err.message });
    throw err;
  }
}

// ─── Notify all general supervisors ─────────────────────────────────────────
async function notifyGeneralSupervisors(messageText, notBeforeTs) {
  try {
    const res = await query(
      `SELECT employee_id, full_name, phone_e164, telegram_id
       FROM employees
       WHERE role = 'general_supervisor' AND is_active = true`
    );

    for (const gs of res.rows) {
      const target = gs.telegram_id || gs.phone_e164;
      if (!target) {
        logger.warn('General supervisor has no contact info', { employeeId: gs.employee_id, name: gs.full_name });
        continue;
      }
      await queueMessage(target, messageText, notBeforeTs);
      logger.info('General supervisor notified', { name: gs.full_name, target });
    }
  } catch (err) {
    logger.error('notifyGeneralSupervisors failed', { err: err.message });
  }
}

async function getQueuedMessages(limit) {
  const res = await query(
    `SELECT outbox_id, to_phone_e164, to_chat_id, message_text, status,
            fail_count, not_before_ts, created_at
     FROM outbox_messages
     WHERE status = 'queued'
       AND not_before_ts <= NOW()
       AND fail_count < 3
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit || 10]
  );
  return res.rows;
}

async function markSent(outboxId) {
  await query(
    `UPDATE outbox_messages SET status = 'sent', sent_ts = NOW() WHERE outbox_id = $1`,
    [outboxId]
  );
}

async function markFailed(outboxId, errorMessage) {
  await query(
    `UPDATE outbox_messages
     SET status = CASE WHEN fail_count >= 2 THEN 'failed'::outbox_status ELSE 'queued'::outbox_status END,
         fail_count = fail_count + 1,
         last_error = $2
     WHERE outbox_id = $1`,
    [outboxId, errorMessage]
  );
}

// ─── Send via OpenClaw CLI ───────────────────────────────────────────────────
// Usa: openclaw message send --channel whatsapp --target <phone> --message <text>

async function sendViaOpenClaw(phoneE164, messageText) {
  return sendViaOpenClawCLI(phoneE164, messageText);
}

function sendViaOpenClawCLI(phoneE164, messageText) {
  return new Promise((resolve, reject) => {
    const args = [
      'message', 'send',
      '--channel', process.env.MESSAGING_CHANNEL || 'telegram',
      '--target', phoneE164,
      '--message', messageText,
      '--json',
    ];

    execFile('openclaw', args, { timeout: 30000 }, (error, stdout, stderr) => {
      if (error) {
        logger.error('OpenClaw CLI send failed', { phone: phoneE164, error: error.message, stderr });
        return reject(new Error(`CLI failed: ${error.message}`));
      }
      logger.info('Sent via OpenClaw CLI', { phone: phoneE164, stdout: stdout.trim() });
      resolve(true);
    });
  });
}

module.exports = {
  queueMessage,
  notifyGeneralSupervisors,
  getQueuedMessages,
  markSent,
  markFailed,
  sendViaOpenClaw,
};
