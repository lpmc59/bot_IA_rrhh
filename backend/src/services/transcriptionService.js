const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * Normalize file:// protocol URLs to local paths.
 * OpenClaw sometimes sends audio/media paths as file:///path/to/file.ogg
 * instead of /path/to/file.ogg — both refer to local files.
 */
function normalizeFilePath(source) {
  if (!source) return source;

  // file:///home/cafe/... → /home/cafe/...
  if (source.startsWith('file://')) {
    const stripped = source.replace(/^file:\/\/(localhost)?/, '');
    logger.info('Normalized file:// URL to local path', { original: source.substring(0, 80), normalized: stripped });
    return stripped;
  }

  // http://localhost:3000/media/inbound/UUID.ogg → /home/cafe/.openclaw/media/inbound/UUID.ogg
  // OpenClaw a veces envía la URL HTTP del gateway en vez de la ruta local del archivo
  const localMediaMatch = source.match(/^https?:\/\/localhost(?::\d+)?\/media\/inbound\/(.+)$/i);
  if (localMediaMatch) {
    const openclawMediaDir = process.env.OPENCLAW_MEDIA_DIR || path.join(require('os').homedir(), '.openclaw', 'media');
    const localPath = path.join(openclawMediaDir, 'inbound', localMediaMatch[1]);
    logger.info('Normalized localhost media URL to local path', { original: source.substring(0, 80), normalized: localPath });
    return localPath;
  }

  return source;
}

/**
 * Transcribe audio from a URL or local file path using OpenAI Whisper API.
 * OpenClaw stores audio locally at ~/.openclaw/media/inbound/*.ogg
 * Supports: local paths (/path/to/file), file:// URLs, and http(s):// URLs.
 * Cost: ~$0.006/min — a 10-second WhatsApp voice note costs ~$0.001.
 */
async function transcribeFromUrl(audioSource) {
  if (!OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY not configured, cannot transcribe audio');
    return null;
  }

  try {
    // Normalize file:// protocol to local path
    audioSource = normalizeFilePath(audioSource);

    let audioBuffer;
    const filename = path.basename(audioSource) || 'voice.ogg';

    // Detect if it's a local file path or an HTTP URL
    if (audioSource.startsWith('/') || audioSource.startsWith('./')) {
      // Local file path (OpenClaw stores media here)
      logger.info('Reading local audio file', { path: audioSource });
      if (!fs.existsSync(audioSource)) {
        throw new Error(`Audio file not found: ${audioSource}`);
      }
      audioBuffer = fs.readFileSync(audioSource);
    } else if (audioSource.startsWith('http://') || audioSource.startsWith('https://')) {
      // Remote URL
      logger.info('Downloading audio from URL', { url: audioSource.substring(0, 80) });
      const audioResponse = await fetch(audioSource);
      if (!audioResponse.ok) {
        throw new Error(`Audio download failed: ${audioResponse.status} ${audioResponse.statusText}`);
      }
      audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    } else {
      throw new Error(`Unsupported audio source: ${audioSource.substring(0, 50)}`);
    }

    logger.info('Audio loaded', { sizeKB: Math.round(audioBuffer.length / 1024), filename });

    // Transcribe with Whisper
    const text = await transcribeBuffer(audioBuffer, filename);
    return text;
  } catch (err) {
    logger.error('transcribeFromUrl failed', { err: err.message });
    return null;
  }
}

/**
 * Transcribe an audio buffer using OpenAI Whisper API.
 * Constructs multipart/form-data manually — no external packages needed.
 */
async function transcribeBuffer(audioBuffer, filename = 'voice.ogg') {
  if (!OPENAI_API_KEY) return null;

  const boundary = `----whisper${Date.now()}${Math.random().toString(36).substring(2)}`;

  // Build multipart body: file + model + language
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: audio/ogg\r\n\r\n`
  );

  const params = Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `whisper-1` +
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="language"\r\n\r\n` +
    `es` +
    `\r\n--${boundary}--\r\n`
  );

  const body = Buffer.concat([preamble, audioBuffer, params]);

  logger.info('Sending audio to Whisper API', { sizeKB: Math.round(audioBuffer.length / 1024) });

  const response = await fetch(WHISPER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Whisper API ${response.status}: ${errBody}`);
  }

  const result = await response.json();
  const text = (result.text || '').trim();

  logger.info('Whisper transcription result', { text: text.substring(0, 80), fullLength: text.length });
  return text || null;
}

module.exports = { transcribeFromUrl, transcribeBuffer };
