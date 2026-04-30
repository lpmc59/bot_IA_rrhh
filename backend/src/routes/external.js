// ============================================================================
// External Tasks API
// ----------------------------------------------------------------------------
// Expuesto en /api/external/tasks
// Autenticado con X-API-Key (env var EXTERNAL_API_KEY).
// Pensado para sistemas externos como optel-redes (NOC/Help-Desk) que
// generan tickets de mantenimiento y quieren que lleguen a empleados
// vía Telegram igual que una asignación de supervisor.
// ============================================================================

const { Router } = require('express');
const logger = require('../utils/logger');
const ext = require('../services/externalTasksService');

const router = Router();

// ─── Auth middleware (API key) ──────────────────────────────────────────────

function validateApiKey(req, res, next) {
  const expected = process.env.EXTERNAL_API_KEY;
  if (!expected) {
    logger.error('EXTERNAL_API_KEY no configurado en .env — endpoint deshabilitado');
    return res.status(503).json({ ok: false, error: 'external_api_not_configured' });
  }
  const got = req.headers['x-api-key'];
  if (!got || got !== expected) {
    return res.status(401).json({ ok: false, error: 'invalid_api_key' });
  }
  next();
}

// Aplicar auth a todas las rutas del router
router.use(validateApiKey);

// ─── Helper de error handling ───────────────────────────────────────────────

function sendError(res, err) {
  if (err instanceof ext.ExternalTaskError) {
    return res.status(err.httpStatus).json({ ok: false, error: err.code, message: err.message });
  }
  logger.error('External tasks endpoint error', { err: err.message, stack: err.stack });
  return res.status(500).json({ ok: false, error: 'internal_error', message: err.message });
}

// ─── POST /api/external/tasks — Crear (o retornar si idempotente) ──────────

router.post('/tasks', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await ext.createExternalTask({
      externalSource:   body.external_source,
      externalRef:      body.external_ref,
      title:            body.title,
      description:      body.description,
      employeeId:       body.employee_id,
      dueDates:         body.due_dates,
      priority:         body.priority,
      plannedMinutes:   body.planned_minutes,
      teamId:           body.team_id,
      projectId:        body.project_id,
      meta:             body.meta,
      // Si optel-redes pone requires_mobile_ui=true, el bot genera un
      // access_token al crear la instance y devuelve mobile_link en la
      // respuesta. Además el mensaje Telegram al técnico incluye el link.
      requiresMobileUi: body.requires_mobile_ui === true,
    });
    // Notificación fuera de la transacción (no bloquea creación si falla outbox)
    let notified = null;
    if (!result.idempotent && result.instance) {
      try {
        notified = await ext.notifyTaskAssigned({
          task: result.task,
          instance: result.instance,
          employee: result.employee,
          mobileLink: result.mobile_link || null,
        });
      } catch (err) {
        logger.warn('Notify on create failed (no bloquea creación)', { err: err.message });
      }
    }
    return res.status(result.idempotent ? 200 : 201).json({
      ok: true,
      idempotent: result.idempotent,
      task_id: result.task.task_id,
      instance_id: result.instance?.instance_id ?? null,
      mobile_link: result.mobile_link || null,
      notified: notified?.sent ?? false,
      notified_reason: notified?.reason ?? null,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── GET /api/external/tasks — Find by external_ref (query params) ─────────
//   ?external_source=optel-redes&external_ref=TICKET-123

router.get('/tasks', async (req, res) => {
  const { external_source, external_ref } = req.query;
  if (!external_source || !external_ref) {
    return res.status(400).json({ ok: false, error: 'missing_params',
      message: 'external_source y external_ref son requeridos' });
  }
  try {
    const task = await ext.findExternalTaskByRef(external_source, external_ref);
    return res.json({ ok: true, task });  // task = null si no existe
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── GET /api/external/tasks/:task_id — Detalle completo ───────────────────

router.get('/tasks/:task_id', async (req, res) => {
  try {
    const detail = await ext.getExternalTask(req.params.task_id);
    if (!detail) {
      return res.status(404).json({ ok: false, error: 'task_not_found' });
    }
    return res.json({ ok: true, ...detail });
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── PATCH /api/external/tasks/:task_id — Actualizar / reasignar ───────────
// Body:
//   { title?, description?, priority?, planned_minutes?, team_id?, project_id?,
//     meta?, reassign_to_employee_id?, notify? }
// notify=false por default — set true para que el empleado reciba aviso
// del cambio por Telegram.

router.patch('/tasks/:task_id', async (req, res) => {
  const body = req.body || {};
  const notify = body.notify === true;
  const reassignTo = body.reassign_to_employee_id || null;
  // Armar fields (los keys con undefined se ignoran en el service)
  const fields = {};
  const trackedChanges = [];
  for (const k of ['title', 'description', 'priority', 'planned_minutes', 'team_id', 'project_id']) {
    if (k in body) { fields[k] = body[k]; trackedChanges.push(k); }
  }
  if ('meta' in body) { fields.external_meta = body.meta; trackedChanges.push('meta'); }

  try {
    const result = await ext.updateExternalTask(req.params.task_id, fields, {
      notify, reassignToEmployeeId: reassignTo,
    });

    // Notificar al empleado si fue reasignación, o si notify=true
    let notified = null;
    if (result.reassignedTo) {
      // Si se reasignó, notificar al nuevo empleado sobre tareas activas hoy
      try {
        notified = await ext.notifyTaskUpdated({
          task: result.task,
          employeeId: result.reassignedTo,
          changes: ['reasignación'],
        });
      } catch (err) {
        logger.warn('Notify on reassign failed', { err: err.message });
      }
    } else if (notify && trackedChanges.length > 0) {
      try {
        notified = await ext.notifyTaskUpdated({
          task: result.task,
          employeeId: result.task.employee_id,
          changes: trackedChanges,
        });
      } catch (err) {
        logger.warn('Notify on update failed', { err: err.message });
      }
    }

    return res.json({
      ok: true,
      task_id: result.task.task_id,
      reassigned_to: result.reassignedTo,
      changes: trackedChanges,
      notified: notified?.sent ?? false,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── DELETE /api/external/tasks/:task_id — Cancelar ────────────────────────

router.delete('/tasks/:task_id', async (req, res) => {
  const reason = req.query.reason || req.body?.reason || null;
  try {
    const result = await ext.cancelExternalTask(req.params.task_id, { reason });
    // Notificar si había instances activas que se cancelaron
    let notified = null;
    if (!result.alreadyCanceled && result.canceledInstances?.length > 0) {
      try {
        notified = await ext.notifyTaskCanceled({
          task: result.task, reason, canceledInstances: result.canceledInstances,
        });
      } catch (err) {
        logger.warn('Notify on cancel failed', { err: err.message });
      }
    }
    return res.json({
      ok: true,
      task_id: result.task.task_id,
      instances_canceled: result.instancesCanceled,
      already_canceled: result.alreadyCanceled,
      notified: notified?.sent ?? false,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── POST /api/external/tasks/:task_id/attachments ─────────────────────────
// Body: { url, type: 'link'|'photo'|'document', caption?, file_name? }

router.post('/tasks/:task_id/attachments', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await ext.attachExternalResource(req.params.task_id, {
      url: body.url,
      type: body.type,
      caption: body.caption,
      fileName: body.file_name,
    });
    return res.status(201).json({
      ok: true,
      attachment_id: result.attachment.attachment_id,
      file_url: result.attachment.file_url,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── PATCH /api/external/tasks/:task_id/status ─────────────────────────────
// Body: { status, note?, notify?, instance_id? }
// status ∈ planned|traveling|on_site|in_progress|done|blocked|canceled
// - blocked requiere note (motivo del bloqueo)
// - instance_id: opcional, por default se usa la instance activa del task
// - notify: opt-in. Defaults según status (true para done/blocked/canceled,
//           false para traveling/on_site/in_progress)

router.patch('/tasks/:task_id/status', async (req, res) => {
  const body = req.body || {};
  if (!body.status) {
    return res.status(422).json({ ok: false, error: 'status_required',
      message: 'status es requerido en el body' });
  }
  try {
    const result = await ext.setExternalTaskStatus(req.params.task_id, {
      status:     body.status,
      note:       body.note,
      notify:     body.notify === undefined ? null : body.notify,
      instanceId: body.instance_id,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return sendError(res, err);
  }
});

// ─── POST /api/external/tasks/:task_id/notes ───────────────────────────────
// Body: { note, notify?, instance_id? }
// Agrega una nota al ticket sin cambiar el status. Útil para que el NOC
// anote observaciones visibles en get_ticket().updates y opcionalmente
// notificar al empleado.

router.post('/tasks/:task_id/notes', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await ext.addExternalTaskNote(req.params.task_id, {
      note:       body.note,
      notify:     body.notify === true,
      instanceId: body.instance_id,
    });
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
