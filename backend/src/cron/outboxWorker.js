const cron = require('node-cron');
const logger = require('../utils/logger');
const outboxService = require('../services/outboxService');

function startOutboxWorker() {
  // Process outbox every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await processOutbox();
    } catch (err) {
      logger.error('Outbox worker failed', { err: err.message });
    }
  });

  logger.info('Outbox worker started (every 30s)');
}

async function processOutbox() {
  const messages = await outboxService.getQueuedMessages(5);

  for (const msg of messages) {
    try {
      const target = msg.to_chat_id || msg.to_phone_e164;
      await outboxService.sendViaOpenClaw(target, msg.message_text);
      await outboxService.markSent(msg.outbox_id);
      logger.info('Outbox message sent', { outboxId: msg.outbox_id, target });
    } catch (err) {
      await outboxService.markFailed(msg.outbox_id, err.message);
      logger.warn('Outbox message failed', { outboxId: msg.outbox_id, err: err.message });
    }
  }
}

module.exports = { startOutboxWorker };
