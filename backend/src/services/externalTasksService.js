// ============================================================================
// External Tasks Service
// ----------------------------------------------------------------------------
// API para sistemas externos (ej. optel-redes NOC/Help-Desk) que crean,
// actualizan, cancelan y anexan recursos a tareas del bot.
//
// Las tareas creadas aquí viven en la misma tabla `app.tasks` que las del
// flujo supervisor, pero se distinguen por `external_source` + `external_ref`.
// Eso nos permite:
//  - Idempotencia por reintentos (mismo ref → misma task, no duplica).
//  - Trazabilidad (¿cuántos tickets de optel hoy? ¿cuál es su ticket_id?).
//  - Flujo unificado: el empleado ve estos tickets igual que cualquier
//    asignación de supervisor.
//
// No reescribe lógica del bot — usa los mismos INSERTs que
// createSupervisorAssignedTask, pero con los metadatos externos y sin token.
// ============================================================================

const { query, getClient } = require('../config/database');
const logger = require('../utils/logger');
const outboxService = require('./outboxService');

// ─── Errores de negocio (codificados para responses HTTP limpias) ───────────
class ExternalTaskError extends Error {
  constructor(code, message, httpStatus = 422) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const MAX_SCHEDULED_DATES = 30;  // safeguard contra requests con arrays enormes

// ─── Helpers ────────────────────────────────────────────────────────────────

function todayIso() {
  // Fecha local del server (mismo comportamiento que el resto del bot)
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDaysIso(base, days) {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Normaliza due_dates: acepta "today", "tomorrow", ISO "YYYY-MM-DD", o Date.
// Filtra pasados, deduplica, ordena. Rechaza si vacío o > MAX_SCHEDULED_DATES.
function normalizeDueDates(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ExternalTaskError('due_dates_required', 'due_dates debe ser un array no vacío');
  }
  const t = todayIso();
  const dates = new Set();
  for (const v of raw) {
    let iso;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'today' || s === 'hoy') iso = t;
      else if (s === 'tomorrow' || s === 'mañana' || s === 'manana') iso = addDaysIso(t, 1);
      else if (/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) iso = v.trim();
      else throw new ExternalTaskError('due_date_invalid', `due_date no reconocido: "${v}"`);
    } else if (v instanceof Date) {
      iso = v.toISOString().slice(0, 10);
    } else {
      throw new ExternalTaskError('due_date_invalid', `due_date tipo inválido: ${typeof v}`);
    }
    if (iso < t) {
      throw new ExternalTaskError('due_date_past', `due_date ${iso} ya pasó (hoy es ${t})`);
    }
    dates.add(iso);
  }
  const sorted = [...dates].sort();
  if (sorted.length > MAX_SCHEDULED_DATES) {
    throw new ExternalTaskError('too_many_dates', `Máximo ${MAX_SCHEDULED_DATES} fechas por ticket`);
  }
  return sorted;
}

// ─── Lookup / búsqueda ──────────────────────────────────────────────────────

async function findExternalTaskByRef(externalSource, externalRef) {
  const r = await query(
    `SELECT * FROM app.tasks
     WHERE external_source = $1 AND external_ref = $2
     LIMIT 1`,
    [externalSource, externalRef]
  );
  return r.rows[0] || null;
}

async function getExternalTask(taskId) {
  const t = await query(`SELECT * FROM app.tasks WHERE task_id = $1`, [taskId]);
  if (!t.rows[0]) return null;

  const instances = await query(
    `SELECT instance_id, work_date, status, progress_percent,
            started_at, completed_at, last_update_at
     FROM app.task_instances
     WHERE task_id = $1
     ORDER BY work_date ASC`,
    [taskId]
  );
  const scheduled = await query(
    `SELECT work_date FROM app.task_scheduled_dates WHERE task_id = $1 ORDER BY work_date`,
    [taskId]
  );
  const attachments = await query(
    `SELECT attachment_id, file_name, file_url, content_type, file_size_bytes, created_at
     FROM app.attachments WHERE task_id = $1 ORDER BY created_at DESC`,
    [taskId]
  );

  return {
    task: t.rows[0],
    instances: instances.rows,
    scheduled_dates: scheduled.rows.map(r => r.work_date),
    attachments: attachments.rows,
  };
}

// ─── Validación del empleado destino ────────────────────────────────────────

async function requireEmployeeAssignable(employeeId) {
  const r = await query(
    `SELECT employee_id, is_active, full_name, telegram_id, phone_e164
     FROM app.employees WHERE employee_id = $1`,
    [employeeId]
  );
  const e = r.rows[0];
  if (!e) throw new ExternalTaskError('employee_not_found', `Empleado ${employeeId} no existe`, 422);
  if (!e.is_active) throw new ExternalTaskError('employee_inactive', `Empleado ${e.full_name} está inactivo`, 422);
  if (!e.telegram_id && !e.phone_e164) {
    throw new ExternalTaskError('employee_no_contact', `Empleado ${e.full_name} sin telegram_id ni phone_e164 — no recibirá notificaciones`, 422);
  }
  return e;
}

// ─── CREATE ─────────────────────────────────────────────────────────────────

async function createExternalTask(params) {
  const {
    externalSource, externalRef,
    title, description, employeeId,
    dueDates, priority = 3, plannedMinutes = null,
    teamId = null, projectId = null, meta = null,
  } = params;

  if (!externalSource) throw new ExternalTaskError('external_source_required', 'external_source requerido');
  if (!externalRef) throw new ExternalTaskError('external_ref_required', 'external_ref requerido');
  if (!title || !title.trim()) throw new ExternalTaskError('title_required', 'title requerido');
  if (!employeeId) throw new ExternalTaskError('employee_id_required', 'employee_id requerido');

  const employee = await requireEmployeeAssignable(employeeId);

  // Idempotencia: si existe, retornar sin duplicar.
  const existing = await findExternalTaskByRef(externalSource, externalRef);
  if (existing) {
    logger.info('External task idempotent hit', {
      externalSource, externalRef, taskId: existing.task_id,
    });
    return { task: existing, instance: null, employee, idempotent: true };
  }

  const dates = normalizeDueDates(dueDates);
  const today = todayIso();
  const includesToday = dates.includes(today);
  // Fecha "representativa" para due_date en la tabla tasks:
  //   - Si hay hoy, usamos hoy
  //   - Si no, la más temprana
  const primaryDate = includesToday ? today : dates[0];
  // Si hay múltiples fechas → frequency='adhoc' + registros en task_scheduled_dates
  const frequency = dates.length > 1 ? 'adhoc' : 'once';

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // INSERT en app.tasks
    const taskRes = await client.query(
      `INSERT INTO app.tasks (
         employee_id, project_id, title, description, priority,
         planned_minutes, status, due_date,
         assigned_by, created_by,
         frequency, weekday_mask, team_id,
         external_source, external_ref, external_meta
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, 'backlog', $7,
         NULL, NULL,
         $8, 0, $9,
         $10, $11, $12
       )
       RETURNING *`,
      [
        employeeId, projectId, title.trim(), description || null, priority,
        plannedMinutes, primaryDate,
        frequency, teamId,
        externalSource, externalRef, meta ? JSON.stringify(meta) : null,
      ]
    );
    const task = taskRes.rows[0];

    // INSERT en task_scheduled_dates si múltiples fechas
    if (dates.length > 1) {
      for (const d of dates) {
        await client.query(
          `INSERT INTO app.task_scheduled_dates (task_id, work_date)
           VALUES ($1, $2)
           ON CONFLICT (task_id, work_date) DO NOTHING`,
          [task.task_id, d]
        );
      }
    }

    // INSERT inmediato en task_instances si alguna fecha = hoy
    let instance = null;
    if (includesToday) {
      const shiftRow = await client.query(
        `SELECT shift_id FROM app.shift_assignments
         WHERE employee_id = $1 AND work_date = $2 LIMIT 1`,
        [employeeId, today]
      );
      const ordRow = await client.query(
        `SELECT COALESCE(MAX(display_order), 0) + 1 AS next_ord
         FROM app.task_instances WHERE employee_id = $1 AND work_date = $2`,
        [employeeId, today]
      );
      // Sin ON CONFLICT: el UNIQUE (employee_id, work_date, task_id) es
      // índice parcial (WHERE task_id IS NOT NULL) y Postgres no resuelve
      // ON CONFLICT sobre índices parciales sin repetir el predicado.
      // No es necesario aquí: findExternalTaskByRef ya protegió la
      // idempotencia a nivel task, así que el task.task_id recién creado
      // nunca puede colisionar con un task_instance previo.
      const instRes = await client.query(
        `INSERT INTO app.task_instances (
           employee_id, work_date, shift_id, task_id,
           title, description, standard_minutes,
           status, display_order, created_by, progress_percent
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7,
           'planned', $8, NULL, 0
         )
         RETURNING *`,
        [
          employeeId, today, shiftRow.rows[0]?.shift_id || null, task.task_id,
          title.trim(), description || null, plannedMinutes,
          ordRow.rows[0].next_ord,
        ]
      );
      instance = instRes.rows[0] || null;
    }

    await client.query('COMMIT');
    logger.info('External task created', {
      externalSource, externalRef,
      taskId: task.task_id, instanceId: instance?.instance_id,
      dates, includesToday,
    });
    return { task, instance, employee, idempotent: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── UPDATE ─────────────────────────────────────────────────────────────────

const UPDATABLE_FIELDS = ['title', 'description', 'priority', 'planned_minutes', 'team_id', 'project_id', 'external_meta'];

async function updateExternalTask(taskId, fields, { notify = false, reassignToEmployeeId = null } = {}) {
  // Validar que existe
  const existing = await query(`SELECT * FROM app.tasks WHERE task_id = $1`, [taskId]);
  if (!existing.rows[0]) throw new ExternalTaskError('task_not_found', `Task ${taskId} no existe`, 404);
  const task = existing.rows[0];
  if (task.status === 'canceled') throw new ExternalTaskError('task_canceled', 'Tarea ya cancelada, no se puede editar', 409);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Reasignación (empleado) tiene su propio flujo con validación
    let newEmployee = null;
    if (reassignToEmployeeId && reassignToEmployeeId !== task.employee_id) {
      newEmployee = await requireEmployeeAssignable(reassignToEmployeeId);
      await client.query(
        `UPDATE app.tasks SET employee_id = $1 WHERE task_id = $2`,
        [reassignToEmployeeId, taskId]
      );
      // Instances pendientes → reasignar también
      await client.query(
        `UPDATE app.task_instances
         SET employee_id = $1
         WHERE task_id = $2 AND status IN ('planned', 'blocked')`,
        [reassignToEmployeeId, taskId]
      );
    }

    // Actualizar campos simples
    const setFragments = [];
    const values = [];
    let i = 1;
    for (const key of UPDATABLE_FIELDS) {
      if (key in fields && fields[key] !== undefined) {
        setFragments.push(`${key} = $${i++}`);
        const v = fields[key];
        values.push(key === 'external_meta' && v !== null ? JSON.stringify(v) : v);
      }
    }
    if (setFragments.length > 0) {
      values.push(taskId);
      await client.query(
        `UPDATE app.tasks SET ${setFragments.join(', ')} WHERE task_id = $${i}`,
        values
      );
      // Propagar title/description a instances activas (para consistencia)
      if ('title' in fields || 'description' in fields) {
        await client.query(
          `UPDATE app.task_instances
           SET title = COALESCE($1, title), description = COALESCE($2, description)
           WHERE task_id = $3 AND status IN ('planned', 'in_progress', 'blocked')`,
          [fields.title ?? null, fields.description ?? null, taskId]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const updated = (await query(`SELECT * FROM app.tasks WHERE task_id = $1`, [taskId])).rows[0];
  return { task: updated, reassignedTo: reassignToEmployeeId || null, notify };
}

// ─── CANCEL ─────────────────────────────────────────────────────────────────

async function cancelExternalTask(taskId, { reason = null } = {}) {
  const existing = await query(`SELECT * FROM app.tasks WHERE task_id = $1`, [taskId]);
  if (!existing.rows[0]) throw new ExternalTaskError('task_not_found', `Task ${taskId} no existe`, 404);
  const task = existing.rows[0];
  if (task.status === 'canceled') {
    return { task, instancesCanceled: 0, alreadyCanceled: true };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE app.tasks SET status = 'canceled' WHERE task_id = $1`,
      [taskId]
    );
    const instRes = await client.query(
      `UPDATE app.task_instances
       SET status = 'canceled', last_update_at = NOW()
       WHERE task_id = $1 AND status IN ('planned', 'in_progress', 'blocked')
       RETURNING instance_id, employee_id, status`,
      [taskId]
    );

    await client.query('COMMIT');
    logger.info('External task canceled', {
      taskId, reason, instancesCanceled: instRes.rowCount,
    });
    return {
      task: { ...task, status: 'canceled' },
      instancesCanceled: instRes.rowCount,
      canceledInstances: instRes.rows,
      alreadyCanceled: false,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── ATTACHMENTS ────────────────────────────────────────────────────────────

async function attachExternalResource(taskId, { url, type, caption = null, fileName = null }) {
  if (!url) throw new ExternalTaskError('url_required', 'url requerida', 422);
  if (!['link', 'photo', 'document'].includes(type)) {
    throw new ExternalTaskError('type_invalid', 'type debe ser link|photo|document', 422);
  }

  const existing = await query(
    `SELECT task_id, employee_id FROM app.tasks WHERE task_id = $1`, [taskId]
  );
  if (!existing.rows[0]) throw new ExternalTaskError('task_not_found', `Task ${taskId} no existe`, 404);

  // Mapeo tipo → content_type y file_name por default
  const contentTypeMap = {
    link: 'text/uri-list',
    photo: 'image/*',
    document: 'application/octet-stream',
  };
  const defaultFileName = fileName || caption || `external_${type}_${Date.now()}`;

  const r = await query(
    `INSERT INTO app.attachments (
       task_id, employee_id, file_name, file_url, content_type
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING attachment_id, file_name, file_url, content_type, created_at`,
    [taskId, existing.rows[0].employee_id, defaultFileName, url, contentTypeMap[type]]
  );
  logger.info('External attachment added', {
    taskId, attachmentId: r.rows[0].attachment_id, type,
  });
  return { attachment: r.rows[0], caption };
}

// ─── NOTIFICACIONES (se llaman desde el route, fuera de la transacción DB) ──

async function notifyTaskAssigned({ task, instance, employee, attachments = [] }) {
  if (!employee) return { sent: false, reason: 'no_employee' };
  const target = employee.telegram_id || employee.phone_e164;
  if (!target) return { sent: false, reason: 'no_contact' };

  // Solo notificamos si hay instance activa hoy (si es "mañana" se notifica
  // cuando el cron genere la instance al check-in del empleado).
  if (!instance) return { sent: false, reason: 'no_instance_today' };

  const priorityEmoji = (task.priority || 3) <= 2 ? '🔴' : '📋';
  const lines = [
    `${priorityEmoji} *Tarea asignada*`,
    `${task.title}`,
  ];
  if (task.description) lines.push(`\n${task.description}`);
  if (task.planned_minutes) lines.push(`⏱️ ~${task.planned_minutes} min estimados`);
  if (attachments.length > 0) {
    lines.push('\n📎 Adjuntos:');
    for (const a of attachments) {
      const cap = a.caption ? ` — ${a.caption}` : '';
      lines.push(`  • ${a.url}${cap}`);
    }
  }
  lines.push(`\nResponde "empiezo" cuando vayas a iniciarla.`);

  await outboxService.queueMessage(target, lines.join('\n'));
  return { sent: true, target };
}

async function notifyTaskCanceled({ task, reason, canceledInstances }) {
  // Solo notificamos si había una instance activa cuya cancelación afecta al empleado hoy
  if (!canceledInstances || canceledInstances.length === 0) return { sent: false };

  // Obtener empleado para el target
  const empRes = await query(
    `SELECT telegram_id, phone_e164 FROM app.employees WHERE employee_id = $1`,
    [task.employee_id]
  );
  const e = empRes.rows[0];
  if (!e) return { sent: false };
  const target = e.telegram_id || e.phone_e164;
  if (!target) return { sent: false };

  const msg = [
    `🚫 *Tarea cancelada*`,
    `${task.title}`,
    reason ? `Motivo: ${reason}` : null,
    `\nNo es necesario continuar con esta tarea.`,
  ].filter(Boolean).join('\n');
  await outboxService.queueMessage(target, msg);
  return { sent: true, target };
}

async function notifyTaskUpdated({ task, employeeId, changes = [] }) {
  const empRes = await query(
    `SELECT telegram_id, phone_e164 FROM app.employees WHERE employee_id = $1`,
    [employeeId]
  );
  const e = empRes.rows[0];
  if (!e) return { sent: false };
  const target = e.telegram_id || e.phone_e164;
  if (!target) return { sent: false };

  const msg = [
    `📝 *Actualización de tarea*`,
    `${task.title}`,
    changes.length > 0 ? `\nCambios: ${changes.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  await outboxService.queueMessage(target, msg);
  return { sent: true, target };
}

// ─── Export ─────────────────────────────────────────────────────────────────

module.exports = {
  ExternalTaskError,
  createExternalTask,
  updateExternalTask,
  cancelExternalTask,
  attachExternalResource,
  getExternalTask,
  findExternalTaskByRef,
  notifyTaskAssigned,
  notifyTaskCanceled,
  notifyTaskUpdated,
};
