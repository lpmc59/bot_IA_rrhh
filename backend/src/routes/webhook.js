const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const logger = require('../utils/logger');
const { getTodayDate } = require('../utils/dateHelper');
const { query } = require('../config/database');
const messageService = require('../services/messageService');
const attachmentService = require('../services/attachmentService');
const employeeService = require('../services/employeeService');
const taskService = require('../services/taskService');
const transcriptionService = require('../services/transcriptionService');
const outboxService = require('../services/outboxService');
const nlpService = require('../services/nlpService');

const router = Router();

// ─── Message deduplication (prevents OpenClaw retry storms) ──────────────────
const recentMessages = new Map(); // key: "phone:hash" → timestamp
const DEDUP_WINDOW_MS = 60_000;   // ignore same message within 60 seconds

function isDuplicate(phone, text) {
  if (!phone || !text) return false;
  const key = `${phone}:${text.trim().toLowerCase().substring(0, 100)}`;
  const now = Date.now();
  const prev = recentMessages.get(key);
  if (prev && (now - prev) < DEDUP_WINDOW_MS) {
    return true;
  }
  recentMessages.set(key, now);
  // Cleanup old entries every 100 messages
  if (recentMessages.size > 500) {
    for (const [k, ts] of recentMessages) {
      if (now - ts > DEDUP_WINDOW_MS) recentMessages.delete(k);
    }
  }
  return false;
}

// ─── Send reply to user (direct CLI, fallback to outbox queue) ───────────────
// target can be a phone (E.164 starting with +) or a Telegram chat ID (numeric string).
// outboxService.sendViaOpenClaw / queueMessage both accept either form.
async function sendReply(target, replyText) {
  if (!replyText) return;
  if (!target) {
    logger.warn('sendReply skipped: no target (phone/telegramId both null)', {
      replyPreview: String(replyText).substring(0, 80),
    });
    return;
  }
  try {
    await outboxService.sendViaOpenClaw(target, replyText);
  } catch (err) {
    logger.warn('Direct CLI send failed, queueing via outbox', { target, err: err.message });
    try {
      await outboxService.queueMessage(target, replyText);
    } catch (queueErr) {
      logger.error('Outbox queue also failed', { target, err: queueErr.message });
    }
  }
}

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: process.env.UPLOAD_DIR || './uploads',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|pdf|doc|docx/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    cb(null, ext || mime);
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK HÍBRIDO:
// - Si el NLP local reconoce el mensaje → responde SYNC con {reply: "..."}
//   para que SOUL.md/OpenClaw lo muestre directamente al usuario.
// - Si necesita Claude (NLP complejo) o es audio/media → responde {ok:true}
//   y procesa en segundo plano, enviando reply vía CLI.
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/openclaw', async (req, res) => {
  const payload = req.body;
  const eventType = payload.type || payload.event || 'message';

  // Extract Telegram user ID if present
  const telegramId = payload.telegramUserId || payload.telegram_user_id
    || payload.chatId || payload.chat_id || null;

  // ─── Identifier resolution ──────────────────────────────────────────────
  // - lookupPhone: real E.164 phone for DB lookup (null on Telegram-only users)
  // - replyTarget: where to send the reply (telegramId for Telegram, phone for WhatsApp)
  // For Telegram, payload.from is often the chat ID (numeric) and NOT a real phone,
  // so we must not normalize it as a phone — that would create a fake "+502..." number.
  const channel = process.env.MESSAGING_CHANNEL || 'telegram';
  const isTelegramChannel = channel === 'telegram';
  const lookupPhone = isTelegramChannel
    ? normalizePhone(payload.phone || payload.sender)  // only if explicitly provided as phone
    : normalizePhone(payload.from || payload.sender || payload.phone);
  const replyTarget = telegramId || lookupPhone;

  logger.info('Webhook received', {
    type: eventType,
    from: payload.from,
    telegramId,
    channel: payload.channel,
    hasMedia: !!payload.media,
    hasAudio: !!(payload.hasAudio || payload.isVoice),
    mediaType: payload.mediaType || payload.media?.mimetype || 'none',
    payloadKeys: Object.keys(payload).join(','),
  });

  // ─── FAST PATH: texto con match local → respuesta síncrona ──────────────
  if (eventType === 'message' || eventType === 'text') {
    const text = (payload.text || payload.message || payload.body || '').trim();
    const hasAudio = payload.hasAudio || payload.isVoice || payload.mediaType === 'audio'
      || payload.type === 'audio' || payload.type === 'ptt';

    if (text && !hasAudio) {
      const localNLP = nlpService.tryLocalNLP(text);

      if (localNLP && localNLP.confidence >= 0.8) {
        // Local NLP matched → process sync → reply in HTTP response
        const dedupKey = replyTarget || lookupPhone;
        if (isDuplicate(dedupKey, text)) {
          logger.warn('Duplicate message ignored (fast path)', { target: dedupKey, text: text.substring(0, 40) });
          return res.json({ ok: true });
        }

        try {
          const result = await messageService.processInboundMessage({
            phone: lookupPhone,
            openclawUserId: payload.userId || payload.openclaw_user_id,
            telegramId,
            text,
            channel,
            rawPayload: payload,
          });
          logger.info('Fast path: sync reply', { target: replyTarget, intent: localNLP.intent });
          return res.json({ reply: result.reply });
        } catch (err) {
          logger.error('Fast path processing failed', { err: err.message, stack: err.stack });
          return res.json({ reply: 'Tuve un problema procesando tu mensaje. Intenta de nuevo o escribe "mis tareas".' });
        }
      }
    }
  }

  // ─── SLOW PATH: Claude, audio, media → respuesta async ─────────────────
  res.json({ ok: true });
  setImmediate(() => {
    processWebhookAsync(payload).catch(err => {
      logger.error('Async webhook processing error', { err: err.message, stack: err.stack });
    });
  });
});

// ─── Async processing of incoming webhook ────────────────────────────────────

async function processWebhookAsync(payload) {
  const eventType = payload.type || payload.event || 'message';
  const telegramId = payload.telegramUserId || payload.telegram_user_id
    || payload.chatId || payload.chat_id || null;

  // ═══════════════════════════════════════════════════════════════════════════
  // TEXT / AUDIO MESSAGES
  // ═══════════════════════════════════════════════════════════════════════════
  // - lookupPhone: real E.164 phone (null on Telegram-only users)
  // - replyTarget: where to deliver the reply (telegramId for Telegram, phone for WhatsApp)
  const channel = process.env.MESSAGING_CHANNEL || 'telegram';
  const isTelegramChannel = channel === 'telegram';
  const lookupPhone = isTelegramChannel
    ? normalizePhone(payload.phone || payload.sender)
    : normalizePhone(payload.from || payload.sender || payload.phone);
  const replyTarget = telegramId || lookupPhone;

  // ═══════════════════════════════════════════════════════════════════════════
  // LOCATION EVENT (Telegram "share location" button)
  // ═══════════════════════════════════════════════════════════════════════════
  // Telegram envia un mensaje con un objeto location: {latitude, longitude, horizontal_accuracy?}
  // OpenClaw lo puede forwardear con type='location' o como campo dentro del payload normal.
  const locationData = extractLocationFromPayload(payload);
  if (locationData) {
    const openclawUserId = payload.userId || payload.openclaw_user_id;
    logger.info('Location event received', {
      target: replyTarget, lat: locationData.latitude, lng: locationData.longitude,
      accuracy: locationData.accuracy_m,
    });
    const result = await messageService.processInboundMessage({
      phone: lookupPhone,
      openclawUserId,
      telegramId,
      text: '',
      channel,
      rawPayload: payload,
      locationPayload: locationData,
    });
    await sendReply(replyTarget, result.reply);
    return;
  }

  if (eventType === 'message' || eventType === 'text') {
    let text = payload.text || payload.message || payload.body || '';
    const openclawUserId = payload.userId || payload.openclaw_user_id;
    const hasAudio = payload.hasAudio || payload.isVoice || payload.mediaType === 'audio'
      || payload.type === 'audio' || payload.type === 'ptt';
    const audioUrl = payload.audioUrl || payload.media?.url || payload.mediaUrl
      || payload.filePath || payload.media?.filePath;

    // ─── Deduplication check ──────────────────────────────────────────────
    if (isDuplicate(replyTarget || lookupPhone, text || audioUrl || '')) {
      logger.warn('Duplicate message ignored (async path)', { target: replyTarget, text: (text || '').substring(0, 40) });
      return;
    }

    // ─── Audio/Voice note handling with Whisper transcription ─────────────
    if (hasAudio || (!text && audioUrl)) {
      if (audioUrl) {
        logger.info('Voice note detected, transcribing with Whisper', {
          target: replyTarget, audioUrl: audioUrl.substring(0, 80),
          hasAudio, fields: Object.keys(payload).join(','),
        });
        const transcribed = await transcriptionService.transcribeFromUrl(audioUrl);
        if (transcribed) {
          text = transcribed;
          logger.info('Voice note transcribed', { target: replyTarget, text: text.substring(0, 60) });
        } else {
          await sendReply(replyTarget, '🎤 Recibí tu audio pero no pude transcribirlo. Por favor escribe tu mensaje como texto.');
          return;
        }
      } else {
        await sendReply(replyTarget, '🎤 Recibí tu nota de voz pero no tengo acceso al audio. Por favor escribe tu mensaje como texto.');
        return;
      }
    }

    // ─── Empty message ───────────────────────────────────────────────────
    if (!text) return;

    // ─── Process message (will use Claude since local NLP didn't match) ──
    const result = await messageService.processInboundMessage({
      phone: lookupPhone,
      openclawUserId,
      telegramId,
      text: text.trim(),
      channel,
      rawPayload: payload,
      isVoiceTranscription: !!hasAudio,
    });

    await sendReply(replyTarget, result.reply);
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MEDIA (images, audio, voice notes)
  // ═══════════════════════════════════════════════════════════════════════════
  if (eventType === 'media' || eventType === 'image' || eventType === 'photo'
      || eventType === 'audio' || eventType === 'ptt' || eventType === 'voice') {
    const openclawUserId = payload.userId || payload.openclaw_user_id;
    const caption = payload.caption || payload.text || '';
    const mediaUrl = payload.mediaUrl || payload.media?.url || payload.filePath || payload.media?.filePath;
    const mimeType = payload.mimeType || payload.media?.mimetype || payload.mimetype || '';

    logger.info('Media event received', {
      target: replyTarget, mediaUrl: (mediaUrl || 'none').substring(0, 100),
      mimeType, eventType, fields: Object.keys(payload).join(','),
    });

    // ─── If media is AUDIO → route to transcription ──────────────────────
    const isAudio = eventType === 'audio' || eventType === 'ptt' || eventType === 'voice'
      || mimeType.startsWith('audio/') || (mediaUrl && /\.(ogg|opus|mp3|m4a|wav|webm)$/i.test(mediaUrl));

    if (isAudio && mediaUrl) {
      logger.info('Audio media detected, routing to transcription', { target: replyTarget, mediaUrl: mediaUrl.substring(0, 80) });
      const transcribed = await transcriptionService.transcribeFromUrl(mediaUrl);
      if (transcribed) {
        logger.info('Media audio transcribed', { target: replyTarget, text: transcribed.substring(0, 60) });
        let employee = null;
        if (telegramId) employee = await employeeService.findByTelegramId(telegramId);
        if (!employee && openclawUserId) employee = await employeeService.findByOpenclawUserId(openclawUserId);
        if (!employee && lookupPhone) employee = await employeeService.findByPhone(lookupPhone);

        if (!employee) {
          await sendReply(replyTarget, 'No te tenemos registrado en el sistema.');
          return;
        }

        const result = await messageService.processInboundMessage({
          phone: lookupPhone, openclawUserId, telegramId, text: transcribed.trim(),
          channel, rawPayload: payload, isVoiceTranscription: true,
        });
        await sendReply(replyTarget, result.reply);
      } else {
        await sendReply(replyTarget, '🎤 Recibí tu audio pero no pude transcribirlo. Por favor escribe tu mensaje como texto.');
      }
      return;
    }

    // ─── Photo/image handling ────────────────────────────────────────────
    let employee = null;
    if (telegramId) employee = await employeeService.findByTelegramId(telegramId);
    if (!employee && openclawUserId) employee = await employeeService.findByOpenclawUserId(openclawUserId);
    if (!employee && lookupPhone) employee = await employeeService.findByPhone(lookupPhone);

    if (!employee) {
      await sendReply(replyTarget, 'No te tenemos registrado en el sistema.');
      return;
    }

    const workDate = getTodayDate();

    const sessionRes = await query(
      `SELECT session_id, state, state_payload FROM chat_sessions
       WHERE employee_id = $1 AND channel = $2 LIMIT 1`,
      [employee.employee_id, channel]
    );
    const session = sessionRes.rows[0];
    const isAdhocConfirm = session && session.state === 'WAITING_ADHOC_CONFIRM';

    let reply = '';
    if (mediaUrl) {
      const targetInstanceId = isAdhocConfirm
        ? null
        : (await taskService.getActiveTask(employee.employee_id, workDate))?.instance_id;

      const attachment = await attachmentService.savePhotoFromOpenClaw(
        employee.employee_id,
        targetInstanceId,
        mediaUrl,
        payload.fileName || 'photo.jpg',
        payload.mimeType || 'image/jpeg',
        payload.fileSize || 0
      );

      if (attachment) {
        if (isAdhocConfirm) {
          const statePayload = session.state_payload || {};
          const pendingPhotos = statePayload.pendingPhotos || [];
          pendingPhotos.push(attachment.attachmentId);
          await query(
            `UPDATE chat_sessions SET state_payload = $1 WHERE session_id = $2`,
            [JSON.stringify({ ...statePayload, pendingPhotos }), session.session_id]
          );
          const photoCount = pendingPhotos.length;
          reply = `📸 Foto recibida (${photoCount} en total).\n📋 Tarea pendiente: "*${statePayload.title}*"\nResponde *sí* para confirmar o sigue agregando detalles/fotos.`;
        } else {
          reply = `📸 Foto recibida y guardada.`;
          const activeTask = targetInstanceId
            ? await taskService.getActiveTask(employee.employee_id, workDate)
            : null;
          if (activeTask) {
            reply += ` Adjunta a tarea: "*${activeTask.title}*"`;
          }
        }

        if (caption) {
          const captionResult = await messageService.processInboundMessage({
            phone: lookupPhone, openclawUserId, telegramId, text: caption.trim(),
            channel, rawPayload: payload,
          });
          reply += `\n${captionResult.reply}`;
        }
      } else {
        reply = 'Recibí tu foto pero hubo un error al guardarla. Intenta de nuevo.';
      }
    }

    if (reply) {
      await sendReply(replyTarget, reply);
    }
  }

  // Other event types (status, read receipts, etc.) - no action needed
}

// ─── Direct file upload endpoint (alternative to OpenClaw media) ─────────────

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file provided' });
    }

    const { employeeId, instanceId, taskId } = req.body;
    if (!employeeId) {
      return res.status(400).json({ ok: false, error: 'employeeId required' });
    }

    const attachment = await attachmentService.saveAttachment(
      instanceId || null, employeeId, req.file, taskId || null
    );
    return res.json({ ok: true, attachment });
  } catch (err) {
    logger.error('Upload error', { err: err.message });
    return res.status(500).json({ ok: false, error: 'Upload failed' });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'talinda-openclaw-backend', timestamp: new Date().toISOString() });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Extrae datos de ubicacion del payload, soportando varias variantes que
// OpenClaw puede usar al forwardear un mensaje de ubicacion de Telegram.
// Retorna { latitude, longitude, accuracy_m } o null si no hay ubicacion.
function extractLocationFromPayload(payload) {
  const eventType = payload.type || payload.event || '';
  const looksLikeLocationEvent = eventType === 'location' || eventType === 'venue';

  // Posibles ubicaciones del objeto location en el payload
  const candidates = [
    payload.location,
    payload.message?.location,
    payload.venue?.location,
    payload.message?.venue?.location,
    looksLikeLocationEvent ? payload : null,
  ].filter(Boolean);

  for (const c of candidates) {
    const lat = c.latitude ?? c.lat;
    const lng = c.longitude ?? c.lng ?? c.lon;
    if (typeof lat === 'number' && typeof lng === 'number') {
      const acc = c.horizontal_accuracy ?? c.accuracy ?? c.accuracy_m ?? null;
      return {
        latitude: lat,
        longitude: lng,
        accuracy_m: acc != null ? Math.round(acc) : null,
      };
    }
  }
  return null;
}

function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned.startsWith('+')) {
    // Assume Guatemala (+502) if no country code
    if (cleaned.length === 8) cleaned = '+502' + cleaned;
    else cleaned = '+' + cleaned;
  }
  return cleaned;
}

module.exports = router;
