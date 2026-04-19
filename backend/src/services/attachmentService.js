const path = require('path');
const fs = require('fs');
const { query } = require('../config/database');
const logger = require('../utils/logger');

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

/**
 * Normalize file:// and localhost HTTP URLs to local paths.
 * OpenClaw sometimes sends media paths as file:///path/to/file.jpg
 * or as http://localhost:3000/media/inbound/UUID.jpg
 */
function normalizeFilePath(source) {
  if (!source) return source;

  // file:///home/cafe/... → /home/cafe/...
  if (source.startsWith('file://')) {
    const stripped = source.replace(/^file:\/\/(localhost)?/, '');
    logger.info('Normalized file:// URL to local path', { original: source.substring(0, 80), normalized: stripped });
    return stripped;
  }

  // http://localhost:3000/media/inbound/UUID.jpg → /home/cafe/.openclaw/media/inbound/UUID.jpg
  const localMediaMatch = source.match(/^https?:\/\/localhost(?::\d+)?\/media\/inbound\/(.+)$/i);
  if (localMediaMatch) {
    const openclawMediaDir = process.env.OPENCLAW_MEDIA_DIR || path.join(require('os').homedir(), '.openclaw', 'media');
    const localPath = path.join(openclawMediaDir, 'inbound', localMediaMatch[1]);
    logger.info('Normalized localhost media URL to local path', { original: source.substring(0, 80), normalized: localPath });
    return localPath;
  }

  return source;
}

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

/**
 * Save attachment uploaded via REST endpoint.
 * @param {string|null} instanceId - task_instances.instance_id (daily work)
 * @param {string} employeeId
 * @param {object} file - multer file object
 * @param {string|null} taskId - tasks.task_id (backlog, future use)
 */
async function saveAttachment(instanceId, employeeId, file, taskId = null) {
  ensureUploadDir();

  const ext = path.extname(file.originalname);
  const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`;
  const filePath = path.join(UPLOAD_DIR, fileName);

  // File is already saved by multer, just record in DB
  const fileUrl = `/uploads/${fileName}`;

  const res = await query(
    `INSERT INTO attachments (instance_id, task_id, employee_id, file_name, file_url, content_type, file_size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING attachment_id`,
    [instanceId || null, taskId || null, employeeId, file.originalname, fileUrl, file.mimetype, file.size]
  );

  logger.info('Attachment saved', { attachmentId: res.rows[0].attachment_id, fileName });
  return {
    attachmentId: res.rows[0].attachment_id,
    fileUrl,
    fileName: file.originalname,
  };
}

/**
 * Get attachments for a task instance (daily work).
 */
async function getAttachmentsForInstance(instanceId) {
  const res = await query(
    `SELECT * FROM attachments WHERE instance_id = $1 ORDER BY created_at DESC`,
    [instanceId]
  );
  return res.rows;
}

/**
 * Get attachments for a backlog task (future use).
 */
async function getAttachmentsForTask(taskId) {
  const res = await query(
    `SELECT * FROM attachments WHERE task_id = $1 ORDER BY created_at DESC`,
    [taskId]
  );
  return res.rows;
}

/**
 * Save a photo received from OpenClaw (WhatsApp image).
 * @param {string} employeeId
 * @param {string|null} instanceId - task_instances.instance_id
 * @param {string} mediaUrl - URL to download from
 * @param {string} fileName
 * @param {string} contentType
 * @param {number} fileSize
 */
async function savePhotoFromOpenClaw(employeeId, instanceId, mediaUrl, fileName, contentType, fileSize) {
  ensureUploadDir();

  try {
    // Normalize file:// protocol to local path
    mediaUrl = normalizeFilePath(mediaUrl);

    let buffer;
    const isLocalPath = mediaUrl && (mediaUrl.startsWith('/') || mediaUrl.startsWith('./'));

    if (isLocalPath) {
      // ── OpenClaw stores media as local files (e.g. /home/cafe/.openclaw/media/inbound/xxx.jpg) ──
      if (!fs.existsSync(mediaUrl)) {
        throw new Error(`Local file not found: ${mediaUrl}`);
      }
      buffer = fs.readFileSync(mediaUrl);
      logger.info('Photo read from local path', { mediaUrl: mediaUrl.substring(0, 80) });
    } else {
      // ── Remote URL: download via HTTP ──
      const response = await fetch(mediaUrl);
      if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
      buffer = Buffer.from(await response.arrayBuffer());
    }

    const ext = path.extname(isLocalPath ? mediaUrl : fileName) || '.jpg';
    const localName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`;
    const localPath = path.join(UPLOAD_DIR, localName);

    fs.writeFileSync(localPath, buffer);

    const fileUrl = `/uploads/${localName}`;
    const res = await query(
      `INSERT INTO attachments (instance_id, employee_id, file_name, file_url, content_type, file_size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING attachment_id`,
      [instanceId || null, employeeId, fileName, fileUrl, contentType, buffer.length]
    );

    logger.info('Photo from OpenClaw saved', {
      attachmentId: res.rows[0].attachment_id,
      instanceId: instanceId || 'none',
      source: isLocalPath ? 'local' : 'remote',
      size: buffer.length,
    });
    return { attachmentId: res.rows[0].attachment_id, fileUrl };
  } catch (err) {
    logger.error('savePhotoFromOpenClaw failed', { err: err.message, mediaUrl: (mediaUrl || '').substring(0, 100) });
    return null;
  }
}

/**
 * Link pending attachments (saved with instance_id=NULL) to a newly created task instance.
 * Used after ad-hoc task confirmation: photos uploaded during WAITING_ADHOC_CONFIRM
 * get linked to the task once the employee confirms.
 */
async function linkAttachmentsToInstance(attachmentIds, instanceId) {
  if (!attachmentIds || attachmentIds.length === 0) return 0;
  const res = await query(
    `UPDATE attachments SET instance_id = $1
     WHERE attachment_id = ANY($2::uuid[]) AND instance_id IS NULL`,
    [instanceId, attachmentIds]
  );
  if (res.rowCount > 0) {
    logger.info('Attachments linked to instance', { instanceId, count: res.rowCount });
  }
  return res.rowCount;
}

module.exports = { saveAttachment, getAttachmentsForTask, getAttachmentsForInstance, savePhotoFromOpenClaw, linkAttachmentsToInstance };
