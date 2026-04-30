const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const logger = require('../utils/logger');
const taskService = require('../services/taskService');
const outboxService = require('../services/outboxService');

const router = Router();

// ─── Multer config ─────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: process.env.UPLOAD_DIR || './uploads',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `checklist-${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 25) * 1024 * 1024 }, // 25MB for iPhone
  fileFilter: (req, file, cb) => {
    // Accept: JPEG, PNG, GIF, WebP, HEIC/HEIF (iPhone native)
    const allowedExt = /\.(jpe?g|png|gif|webp|heic|heif)$/i;
    const allowedMime = /^image\/(jpeg|png|gif|webp|heic|heif)$/i;
    const extOk = allowedExt.test(path.extname(file.originalname));
    const mimeOk = allowedMime.test(file.mimetype);
    if (extOk || mimeOk) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no soportado: ${file.mimetype}`));
    }
  },
});

// ─── Token auth middleware ─────────────────────────────────────────────────
async function validateToken(req, res, next) {
  try {
    const token = req.params.token;
    if (!token) {
      return res.status(401).json({ ok: false, error: 'Token requerido' });
    }
    const data = await taskService.getTaskByToken(token);
    if (!data) {
      return res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
    }
    req.taskData = data;
    next();
  } catch (err) {
    logger.error('Token validation error', { err: err.message });
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /task/:token — Datos completos de la tarea
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/task/:token', validateToken, async (req, res) => {
  try {
    const { instance, employee } = req.taskData;
    const [checklist, resources, progress] = await Promise.all([
      taskService.getInstanceChecklist(instance.instanceId),
      taskService.getInstanceResources(instance.instanceId),
      taskService.getChecklistProgress(instance.instanceId),
    ]);

    // Enrich checklist items with photos array
    const checklistIds = checklist.map(c => c.id);
    const photosMap = checklistIds.length > 0
      ? await taskService.getChecklistPhotos(checklistIds)
      : {};

    const enrichedChecklist = checklist.map(c => ({
      ...c,
      photos: photosMap[c.id] || [],
    }));

    // Get team info (if task has team_id)
    const team = await taskService.getTaskTeam(instance.taskId);

    res.json({
      ok: true,
      task: instance,
      employee: { fullName: employee.fullName },
      checklist: enrichedChecklist,
      resources,
      progress,
      team,
    });
  } catch (err) {
    logger.error('GET /task/:token failed', { err: err.message });
    res.status(500).json({ ok: false, error: 'Error al cargar datos' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /task/:token/checklist/:id — Actualizar item del checklist
// ═══════════════════════════════════════════════════════════════════════════════

router.put('/task/:token/checklist/:id', validateToken, async (req, res) => {
  try {
    const { employee, instance } = req.taskData;
    const { status, note } = req.body;

    // Validar status
    if (status && !['done', 'skipped', 'pending'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'Status inválido' });
    }

    const updated = await taskService.updateChecklistItem(
      req.params.id,
      { status, note },
      employee.employeeId
    );

    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Item no encontrado' });
    }

    // Verificar progreso
    const progress = await taskService.getChecklistProgress(instance.instanceId);

    // Si todos los requeridos están completados → notificar por Telegram/WhatsApp
    if (progress.allRequiredDone && status === 'done') {
      try {
        const { query } = require('../config/database');
        const empRes = await query(
          `SELECT telegram_id, phone_e164 FROM employees WHERE employee_id = $1`,
          [employee.employeeId]
        );
        const target = empRes.rows[0]?.telegram_id || empRes.rows[0]?.phone_e164;
        if (target) {
          await outboxService.queueMessage(
            target,
            `✅ ¡Completaste todos los pasos requeridos del checklist de "*${instance.title}*"!\n\nPuedes marcar la tarea como terminada diciendo: *terminé ${instance.title}*`
          );
        }
      } catch (notifErr) {
        logger.warn('Checklist completion notification failed (non-fatal)', { err: notifErr.message });
      }
    }

    res.json({ ok: true, item: updated, progress });
  } catch (err) {
    logger.error('PUT /task/:token/checklist/:id failed', { err: err.message });
    res.status(500).json({ ok: false, error: 'Error al actualizar' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /task/:token/checklist/:id/photo — Subir foto(s) para un item
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/task/:token/checklist/:id/photo', validateToken, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No se recibió foto' });
    }

    const { employee } = req.taskData;
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const originalPath = req.file.path;

    // ─── Server-side resize with sharp (handles HEIC, HEIF, large photos) ───
    let finalFilename = req.file.filename;
    let finalSize = req.file.size;
    try {
      // Always convert to JPEG, max 1920px wide, quality 85%
      const jpgFilename = req.file.filename.replace(/\.\w+$/, '.jpg');
      const jpgPath = path.join(uploadDir, jpgFilename);

      await sharp(originalPath)
        .rotate() // Auto-rotate based on EXIF
        .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(jpgPath);

      const stat = fs.statSync(jpgPath);
      finalSize = stat.size;

      // Delete original if different from output
      if (originalPath !== jpgPath) {
        try { fs.unlinkSync(originalPath); } catch (_) {}
      }

      finalFilename = jpgFilename;
      logger.info('Photo resized', {
        original: req.file.originalname,
        originalSize: req.file.size,
        finalSize,
        filename: finalFilename,
      });
    } catch (sharpErr) {
      // If sharp fails, use original file as-is
      logger.warn('Sharp resize failed, using original', { err: sharpErr.message });
      finalFilename = req.file.filename;
      finalSize = req.file.size;
    }

    const photoUrl = `/uploads/${finalFilename}`;

    const photo = await taskService.addChecklistPhoto(
      req.params.id,
      photoUrl,
      req.file.originalname,
      finalSize,
      employee.employeeId
    );

    if (!photo) {
      return res.status(404).json({ ok: false, error: 'Item no encontrado' });
    }

    // Also update legacy photo_url to first/latest photo
    await taskService.updateChecklistItem(
      req.params.id,
      { photoUrl },
      employee.employeeId
    );

    res.json({ ok: true, photo, photoUrl });
  } catch (err) {
    // Handle multer file size errors
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, error: 'La foto es muy grande. Máximo 25MB.' });
    }
    logger.error('POST /task/:token/checklist/:id/photo failed', { err: err.message });
    res.status(500).json({ ok: false, error: 'Error al subir foto' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /task/:token/checklist/:checklistId/photo/:photoId — Borrar una foto
// ═══════════════════════════════════════════════════════════════════════════════

router.delete('/task/:token/checklist/:checklistId/photo/:photoId', validateToken, async (req, res) => {
  try {
    const deleted = await taskService.deleteChecklistPhoto(req.params.photoId);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: 'Foto no encontrada' });
    }

    // Try to delete the physical file (non-critical)
    try {
      const uploadDir = process.env.UPLOAD_DIR || './uploads';
      const filePath = path.join(uploadDir, path.basename(deleted.file_url));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (fsErr) {
      logger.warn('Could not delete photo file (non-fatal)', { err: fsErr.message });
    }

    // Update legacy photo_url to latest remaining photo
    const photos = await taskService.getChecklistPhotos([req.params.checklistId]);
    const remaining = photos[req.params.checklistId] || [];
    const latestUrl = remaining.length > 0 ? remaining[remaining.length - 1].file_url : null;
    await taskService.updateChecklistItem(
      req.params.checklistId,
      { photoUrl: latestUrl },
      req.taskData.employee.employeeId
    );

    res.json({ ok: true, deleted: deleted.photo_id });
  } catch (err) {
    logger.error('DELETE photo failed', { err: err.message });
    res.status(500).json({ ok: false, error: 'Error al eliminar foto' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /task/:token/resource/:id — Confirmar recurso
// ═══════════════════════════════════════════════════════════════════════════════

router.put('/task/:token/resource/:id', validateToken, async (req, res) => {
  try {
    const { employee } = req.taskData;
    const { confirmed, notes } = req.body;

    const updated = await taskService.confirmResource(
      req.params.id,
      confirmed !== false,
      employee.employeeId,
      notes || null
    );

    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Recurso no encontrado' });
    }

    res.json({ ok: true, resource: updated });
  } catch (err) {
    logger.error('PUT /task/:token/resource/:id failed', { err: err.message });
    res.status(500).json({ ok: false, error: 'Error al actualizar recurso' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /task/:token/progress — Progreso ligero (polling)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/task/:token/progress', validateToken, async (req, res) => {
  try {
    const { instance } = req.taskData;
    const progress = await taskService.getChecklistProgress(instance.instanceId);
    res.json({ ok: true, progress, taskStatus: instance.status });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// QUICK ACTIONS  — botones de la UI móvil para tickets (optel-redes y similares)
// ───────────────────────────────────────────────────────────────────────────────
// El técnico opera el ticket sin Telegram desde su navegador móvil. Cada
// acción dispara las MISMAS funciones del taskService que el flujo Telegram,
// para que los reportes de productividad sumen igual sin importar el canal.
// ═══════════════════════════════════════════════════════════════════════════════

// Helper para responder 4xx/5xx coherentemente cuando taskService lanza
// TaskStatusError (transición ilegal, instance not found, etc.)
function _sendActionError(res, err, fallbackStatus = 500) {
  if (err && err.code && err.httpStatus) {
    return res.status(err.httpStatus).json({
      ok: false, error: err.code, message: err.message,
    });
  }
  logger.error('Mobile action error', { err: err?.message, stack: err?.stack });
  return res.status(fallbackStatus).json({ ok: false, error: 'internal_error', message: err?.message });
}

// Wrapper genérico: cambia status de la instance vía setTaskInstanceStatus.
// Mismo motor que /api/external/.../status, así que los reportes y el log
// `task_updates` se generan igual que cualquier otra transición.
async function _setStatus(req, res, newStatus, { requireNote = false } = {}) {
  try {
    const { instance, employee } = req.taskData;
    const note = (req.body?.note || '').trim() || null;
    if (requireNote && !note) {
      return res.status(422).json({ ok: false, error: 'note_required',
        message: `Para status=${newStatus} hay que indicar un motivo en "note".` });
    }
    const result = await taskService.setTaskInstanceStatus(instance.instanceId, newStatus, {
      employeeId: employee.employeeId,
      note,
    });
    res.json({
      ok: true,
      status: result.status,
      previous_status: result.previous,
      changed: result.changed,
    });
  } catch (err) {
    return _sendActionError(res, err);
  }
}

// POST /task/:token/start  → in_progress
router.post('/task/:token/start', validateToken, (req, res) => _setStatus(req, res, 'in_progress'));

// POST /task/:token/traveling
router.post('/task/:token/traveling', validateToken, (req, res) => _setStatus(req, res, 'traveling'));

// POST /task/:token/on-site
router.post('/task/:token/on-site', validateToken, (req, res) => _setStatus(req, res, 'on_site'));

// POST /task/:token/done
router.post('/task/:token/done', validateToken, (req, res) => _setStatus(req, res, 'done'));

// POST /task/:token/blocked  — requiere body.note con el motivo
router.post('/task/:token/blocked', validateToken, (req, res) =>
  _setStatus(req, res, 'blocked', { requireNote: true }));

// POST /task/:token/progress  — body: { progress_percent, note? }
router.post('/task/:token/progress', validateToken, async (req, res) => {
  try {
    const { instance, employee } = req.taskData;
    const pct = parseInt(req.body?.progress_percent, 10);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      return res.status(422).json({ ok: false, error: 'progress_percent_invalid',
        message: 'progress_percent debe ser entero 0..100' });
    }
    const note = (req.body?.note || '').trim() || null;
    await taskService.updateTaskProgress(
      instance.instanceId, pct, employee.employeeId, null, note
    );
    res.json({ ok: true, progress_percent: pct });
  } catch (err) {
    return _sendActionError(res, err);
  }
});

// POST /task/:token/continue-tomorrow  — pausa multi-día
router.post('/task/:token/continue-tomorrow', validateToken, async (req, res) => {
  try {
    const { instance, employee } = req.taskData;
    const result = await taskService.markTaskContinuedTomorrow(
      instance.instanceId, employee.employeeId, {}
    );
    res.json({
      ok: true,
      yesterday_instance_id: result.yesterdayInstanceId,
      tomorrow_instance_id: result.tomorrowInstanceId,
      tomorrow_date: result.tomorrowDate,
      tomorrow_token: result.tomorrowToken || null,
      // El link de mañana es lo que vale: hoy el token actual quedará válido
      // pero la instance será 'continued' (no operable). Mañana hay que usar
      // el nuevo token que sí apunta a la nueva instance.
      tomorrow_mobile_link: result.tomorrowToken
        ? `${(process.env.MOBILE_BASE_URL || '').replace(/\/+$/, '')}/m/task/${result.tomorrowToken}`
        : null,
    });
  } catch (err) {
    return _sendActionError(res, err);
  }
});

// POST /task/:token/note  — body: { note }
// Agrega una nota libre al timeline sin cambiar status.
router.post('/task/:token/note', validateToken, async (req, res) => {
  try {
    const { instance, employee } = req.taskData;
    const note = (req.body?.note || '').trim();
    if (!note) {
      return res.status(422).json({ ok: false, error: 'note_required',
        message: 'note es obligatorio' });
    }
    const { query } = require('../config/database');
    const r = await query(
      `INSERT INTO task_updates (instance_id, employee_id, update_type, note_text)
       VALUES ($1, $2, 'NOTE', $3)
       RETURNING update_id, created_at`,
      [instance.instanceId, employee.employeeId, note]
    );
    await query(
      `UPDATE task_instances SET last_update_at = NOW() WHERE instance_id = $1`,
      [instance.instanceId]
    );
    res.json({
      ok: true,
      update_id: r.rows[0].update_id,
      created_at: r.rows[0].created_at,
    });
  } catch (err) {
    return _sendActionError(res, err);
  }
});

// POST /task/:token/photo  — multipart/form-data: photo file (+ optional caption)
// La foto se guarda en uploads/, se inserta en app.attachments (mismo patrón
// que attachExternalResource) y se loguea como NOTE en task_updates para
// que aparezca en el timeline.
router.post('/task/:token/photo', validateToken, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'photo_required',
        message: 'No se recibió foto en el campo "photo"' });
    }
    const { instance, employee } = req.taskData;
    const uploadDir = process.env.UPLOAD_DIR || './uploads';
    const originalPath = req.file.path;

    // Resize/normalize a JPEG igual que el endpoint de checklist
    let finalFilename = req.file.filename;
    let finalSize = req.file.size;
    try {
      const jpgFilename = req.file.filename.replace(/\.\w+$/, '.jpg');
      const jpgPath = path.join(uploadDir, jpgFilename);
      await sharp(originalPath)
        .rotate()
        .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(jpgPath);
      const stat = fs.statSync(jpgPath);
      finalSize = stat.size;
      if (originalPath !== jpgPath) {
        try { fs.unlinkSync(originalPath); } catch (_) {}
      }
      finalFilename = jpgFilename;
    } catch (sharpErr) {
      logger.warn('Sharp resize failed (mobile/task/photo), using original', { err: sharpErr.message });
    }

    const photoUrl = `/uploads/${finalFilename}`;
    const caption = (req.body?.caption || '').trim() || null;

    // Insertar attachment a nivel task (no a checklist item)
    const { query } = require('../config/database');
    const att = await query(
      `INSERT INTO app.attachments (
         task_id, employee_id, file_name, file_url, content_type, file_size_bytes
       ) VALUES ($1, $2, $3, $4, 'image/jpeg', $5)
       RETURNING attachment_id, file_url, created_at`,
      [instance.taskId, employee.employeeId, req.file.originalname || finalFilename, photoUrl, finalSize]
    );

    // Log en task_updates para que aparezca en el timeline del ticket
    await query(
      `INSERT INTO task_updates (instance_id, employee_id, update_type, note_text)
       VALUES ($1, $2, 'NOTE', $3)`,
      [instance.instanceId, employee.employeeId,
       `📷 Foto adjunta: ${photoUrl}${caption ? ` — ${caption}` : ''}`]
    );
    await query(
      `UPDATE task_instances SET last_update_at = NOW() WHERE instance_id = $1`,
      [instance.instanceId]
    );

    res.json({
      ok: true,
      attachment_id: att.rows[0].attachment_id,
      file_url: photoUrl,
      caption,
    });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ ok: false, error: 'file_too_large',
        message: 'La foto es muy grande. Máximo 25MB.' });
    }
    return _sendActionError(res, err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUPERVISOR TASK ASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function validateAssignToken(req, res, next) {
  try {
    const token = req.params.token;
    if (!token) return res.status(401).json({ ok: false, error: 'Token requerido' });
    const data = await taskService.getAssignmentTokenData(token);
    if (!data) return res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
    req.assignData = data;
    req.assignToken = token;
    next();
  } catch (err) {
    logger.error('Assignment token validation error', { err: err.message });
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
}

router.get('/assign/:token', validateAssignToken, async (req, res) => {
  res.json({
    ok: true,
    supervisor: { name: req.assignData.supervisor_name },
    expiresAt: req.assignData.expires_at,
  });
});

router.get('/assign/:token/employees', validateAssignToken, async (req, res) => {
  try {
    const employees = await taskService.getAllActiveEmployees();
    res.json({ ok: true, employees });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error cargando empleados' });
  }
});

router.get('/assign/:token/projects', validateAssignToken, async (req, res) => {
  try {
    const projects = await taskService.getAllActiveProjects();
    res.json({ ok: true, projects });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error cargando proyectos' });
  }
});

router.get('/assign/:token/teams', validateAssignToken, async (req, res) => {
  try {
    const teams = await taskService.getAllTeams();
    res.json({ ok: true, teams });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error cargando equipos' });
  }
});

router.post('/assign/:token', validateAssignToken, async (req, res) => {
  try {
    const { title, description, employee_id, project_id, priority,
            planned_minutes, due_date, team_id } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ ok: false, error: 'Título es requerido' });
    }
    if (!employee_id) {
      return res.status(400).json({ ok: false, error: 'Empleado es requerido' });
    }
    if (!due_date) {
      return res.status(400).json({ ok: false, error: 'Fecha de ejecución es requerida' });
    }

    // Validate due_date is today or tomorrow
    const { getTodayDate } = require('../utils/dateHelper');
    const today = getTodayDate();
    const tomorrow = new Date(new Date(today).getTime() + 86400000).toISOString().split('T')[0];
    if (due_date !== today && due_date !== tomorrow) {
      return res.status(400).json({ ok: false, error: 'La fecha debe ser hoy o mañana' });
    }

    const result = await taskService.createSupervisorAssignedTask(req.assignToken, {
      title: title.trim(),
      description: description?.trim() || null,
      employee_id,
      project_id: project_id || null,
      priority: parseInt(priority) || 3,
      planned_minutes: parseInt(planned_minutes) || 30,
      due_date,
      team_id: team_id || null,
    });

    // If today, check shift/checkin and notify employee
    let notification = null;
    if (due_date === today && result.instance) {
      notification = await handleTodayTaskNotification(employee_id, today, result.task, req.assignData);
    }

    res.json({ ok: true, task: result.task, instance: result.instance, notification });
  } catch (err) {
    logger.error('POST /assign/:token failed', { err: err.message });
    if (err.message === 'Token inválido o expirado') {
      return res.status(401).json({ ok: false, error: err.message });
    }
    res.status(500).json({ ok: false, error: 'Error al crear tarea' });
  }
});

async function handleTodayTaskNotification(employeeId, workDate, task, supervisorData) {
  try {
    const shiftService = require('../services/shiftService');
    const checkinService = require('../services/checkinService');
    const employeeService = require('../services/employeeService');

    const employee = await employeeService.findById(employeeId);
    if (!employee) return { sent: false, warning: 'Empleado no encontrado' };

    const shift = await shiftService.getCurrentShiftForEmployee(employeeId, workDate);
    const checkedIn = await checkinService.hasCheckedInToday(employeeId, workDate);

    if (!shift) {
      return { sent: false, warning: `${employee.full_name} no tiene turno asignado hoy.` };
    }
    if (!checkedIn) {
      return { sent: false, warning: `${employee.full_name} no ha hecho check-in hoy.` };
    }

    // Employee on shift and checked in → send notification
    const target = employee.telegram_id || employee.phone_e164;
    if (!target) {
      return { sent: false, warning: `${employee.full_name} no tiene medio de contacto registrado.` };
    }

    const message = `🔴 *Tarea urgente asignada*\n\n` +
      `📋 *${task.title}*\n` +
      (task.description ? `📝 ${task.description}\n` : '') +
      `👤 Asignada por: ${supervisorData.supervisor_name}\n` +
      `⏱️ Tiempo estimado: ${task.planned_minutes || 30} min\n\n` +
      `Escribe "mis tareas" para verla.`;

    await outboxService.queueMessage(target, message);
    return { sent: true, warning: null };
  } catch (err) {
    logger.error('handleTodayTaskNotification failed', { err: err.message });
    return { sent: false, warning: 'Error al enviar notificación' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ESCALATION FORM (supervisor_auditor)
// ═══════════════════════════════════════════════════════════════════════════════

async function validateEscalationToken(req, res, next) {
  try {
    const token = req.params.token;
    if (!token) return res.status(401).json({ ok: false, error: 'Token requerido' });
    const data = await taskService.getEscalationByToken(token);
    if (!data) return res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
    req.escalationData = data;
    next();
  } catch (err) {
    logger.error('Escalation token validation error', { err: err.message });
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
}

// GET /api/m/escalation/:token — fetch escalation data for the form
router.get('/escalation/:token', validateEscalationToken, async (req, res) => {
  try {
    const d = req.escalationData;
    res.json({
      ok: true,
      escalation: {
        escalation_id: d.escalation_id,
        reason: d.reason,
        inbound_text: d.inbound_text,
        work_date: d.work_date,
        created_at: d.escalation_created_at,
        employee_name: d.employee_name,
        employee_phone: d.employee_phone,
        supervisor_name: d.supervisor_name,
        // Current form values
        contacto_empleado: d.contacto_empleado,
        instrucciones_dadas: d.instrucciones_dadas,
        nota_adicional: d.nota_adicional,
        resuelto: d.resuelto || 'pendiente',
        form_opened_at: d.form_opened_at,
        resolved_at: d.resolved_at,
      },
    });
  } catch (err) {
    logger.error('GET /escalation/:token failed', { err: err.message });
    res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// PUT /api/m/escalation/:token — update escalation form
router.put('/escalation/:token', validateEscalationToken, async (req, res) => {
  try {
    const { contacto_empleado, instrucciones_dadas, nota_adicional, resuelto } = req.body;

    // Validate resuelto value
    if (resuelto && !['si', 'no', 'pendiente'].includes(resuelto)) {
      return res.status(400).json({ ok: false, error: 'Valor inválido para resuelto. Usar: si, no, pendiente' });
    }

    await taskService.updateEscalationForm(req.escalationData.escalation_id, {
      contacto_empleado: contacto_empleado != null ? Boolean(contacto_empleado) : null,
      instrucciones_dadas: instrucciones_dadas || null,
      nota_adicional: nota_adicional || null,
      resuelto: resuelto || 'pendiente',
    });

    logger.info('Escalation form updated', {
      escalationId: req.escalationData.escalation_id,
      supervisorId: req.escalationData.supervisor_id,
      resuelto,
    });

    res.json({ ok: true, message: 'Formulario actualizado correctamente' });
  } catch (err) {
    logger.error('PUT /escalation/:token failed', { err: err.message });
    res.status(500).json({ ok: false, error: 'Error al guardar formulario' });
  }
});

module.exports = router;
