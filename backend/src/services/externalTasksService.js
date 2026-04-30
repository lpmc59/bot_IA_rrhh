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

// Base URL para construir el link móvil enviado al técnico cuando
// requires_mobile_ui = true.
//
// Para tickets externos (este service) preferimos MOBILE_BASE_URL_EXTERNAL,
// que apunta al dominio del sistema externo (ej. gestion.optel-redes.com).
// Si no está seteada, caemos a MOBILE_BASE_URL (el dominio del bot, ej.
// gestion.talinda.es) — útil cuando ambos sistemas comparten dominio.
//
// nginx debe enrutar el path /m/task/<token> del dominio externo hacia
// el backend del bot (puerto 3000). Ver DEPLOY.md.
const MOBILE_BASE_URL = (
  process.env.MOBILE_BASE_URL_EXTERNAL
  || process.env.MOBILE_BASE_URL
  || 'http://localhost:3000'
).replace(/\/+$/, '');

function buildMobileLink(token) {
  return token ? `${MOBILE_BASE_URL}/m/task/${token}` : null;
}

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
  const task = t.rows[0];

  const instances = await query(
    `SELECT instance_id, work_date, status, progress_percent,
            started_at, completed_at, last_update_at, blocked_reason
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
  // Timeline de eventos/updates a través de todas las instances del task.
  // Útil para que optel-redes muestre histórico de avances/notas/transiciones.
  const updates = await query(
    `SELECT tu.update_id, tu.instance_id, tu.employee_id, tu.update_type,
            tu.progress_percent, tu.note_text, tu.created_at
     FROM app.task_updates tu
     JOIN app.task_instances ti ON ti.instance_id = tu.instance_id
     WHERE ti.task_id = $1
     ORDER BY tu.created_at DESC`,
    [taskId]
  );

  // Si la tarea fue marcada con requires_mobile_ui, devolvemos el link
  // móvil activo (si existe token vivo) para que optel-redes pueda
  // mostrarlo en su UI de ticket o reenviarlo al técnico si lo perdió.
  let mobile_link = null;
  let mobile_token_expires_at = null;
  if (task.requires_mobile_ui) {
    const tok = await query(
      `SELECT t.token, t.expires_at
       FROM app.task_instance_access_tokens t
       JOIN app.task_instances ti ON ti.instance_id = t.instance_id
       WHERE ti.task_id = $1
         AND t.revoked = false
         AND t.expires_at > NOW()
       ORDER BY t.created_at DESC
       LIMIT 1`,
      [taskId]
    );
    if (tok.rows[0]) {
      mobile_link = buildMobileLink(tok.rows[0].token);
      mobile_token_expires_at = tok.rows[0].expires_at;
    }
  }

  return {
    task,
    instances: instances.rows,
    scheduled_dates: scheduled.rows.map(r => r.work_date),
    attachments: attachments.rows,
    updates: updates.rows,
    mobile_link,
    mobile_token_expires_at,
  };
}

// ─── Resolver la task_instance activa para un task (helper) ─────────────────
// Cuando el caller externo (optel-redes) identifica la tarea por task_id,
// necesitamos encontrar la task_instance relevante:
//   - Preferencia: la más reciente con status != ('done','canceled')
//   - Fallback:    la más reciente cualquiera (último día trabajado)
async function getActiveInstanceForTask(taskId) {
  const r = await query(
    `SELECT instance_id, employee_id, status, work_date
     FROM app.task_instances
     WHERE task_id = $1
     ORDER BY
       CASE WHEN status NOT IN ('done','canceled') THEN 0 ELSE 1 END,
       work_date DESC,
       last_update_at DESC NULLS LAST
     LIMIT 1`,
    [taskId]
  );
  return r.rows[0] || null;
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
    requiresMobileUi = false,
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
         external_source, external_ref, external_meta,
         requires_mobile_ui
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, 'backlog', $7,
         NULL, NULL,
         $8, 0, $9,
         $10, $11, $12,
         $13
       )
       RETURNING *`,
      [
        employeeId, projectId, title.trim(), description || null, priority,
        // app.tasks.planned_minutes es NOT NULL → default 0 si el caller no lo pasa
        plannedMinutes ?? 0, primaryDate,
        frequency, teamId,
        externalSource, externalRef, meta ? JSON.stringify(meta) : null,
        !!requiresMobileUi,
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
          title.trim(), description || null, plannedMinutes ?? 0,
          ordRow.rows[0].next_ord,
        ]
      );
      instance = instRes.rows[0] || null;
    }

    await client.query('COMMIT');

    // Si la tarea pide UI móvil y ya existe instance hoy → generar token
    // de inmediato para que el create response devuelva mobile_link y el
    // técnico pueda recibirlo en el primer mensaje (o optel-redes pueda
    // pintarlo en su panel del ticket).
    //
    // Si no hay instance hoy (la fecha es futura), el token se generará
    // automáticamente cuando el cron materialice la instance del día.
    let mobileLink = null;
    let mobileToken = null;
    if (requiresMobileUi && instance) {
      try {
        const taskService = require('./taskService');
        mobileToken = await taskService.generateAccessToken(
          instance.instance_id, employeeId
        );
        mobileLink = buildMobileLink(mobileToken);
      } catch (err) {
        // No fallar el create si el token falla — el ticket ya quedó.
        // optel-redes puede pedirlo después con GET /api/external/tasks/:id
        logger.warn('External task: token generation failed (non-fatal)', {
          taskId: task.task_id, err: err.message,
        });
      }
    }

    logger.info('External task created', {
      externalSource, externalRef,
      taskId: task.task_id, instanceId: instance?.instance_id,
      dates, includesToday,
      requiresMobileUi: !!requiresMobileUi,
      mobileLink: !!mobileLink,
    });
    return {
      task, instance, employee, idempotent: false,
      mobile_link: mobileLink,
      mobile_token: mobileToken,
    };
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

async function notifyTaskAssigned({ task, instance, employee, attachments = [], mobileLink = null }) {
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
  // Si la tarea pide UI móvil, el link es el canal preferido para que el
  // técnico opere — Telegram queda como atajo redundante.
  if (mobileLink) {
    lines.push(`\n📱 Abrí el ticket desde tu móvil:\n${mobileLink}`);
    lines.push(`\nO respondé "empiezo" si preferís Telegram.`);
  } else {
    lines.push(`\nResponde "empiezo" cuando vayas a iniciarla.`);
  }

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

// ─── SET STATUS (optel-redes cambia el estado del ticket) ───────────────────

const STATUS_EMOJI = {
  planned: '📋', traveling: '🚗', on_site: '📍',
  in_progress: '▶️', done: '✅', blocked: '🚫', canceled: '❌',
};
const STATUS_LABEL = {
  planned: 'pendiente', traveling: 'en camino', on_site: 'en el sitio',
  in_progress: 'en progreso', done: 'completada', blocked: 'bloqueada', canceled: 'cancelada',
};

// Notificaciones por status: defaults según conversación con el equipo.
// Caller puede forzar con `notify: true/false` en el request.
const NOTIFY_DEFAULTS = {
  traveling: false, on_site: false, in_progress: false,
  done: true, blocked: true, canceled: true, planned: false,
};

async function setExternalTaskStatus(taskId, { status, note = null, notify = null, instanceId = null }) {
  // Lazy require para evitar circular imports
  const taskService = require('./taskService');

  // Validar task existe y status válido
  const t = await query(`SELECT task_id, title, employee_id FROM app.tasks WHERE task_id = $1`, [taskId]);
  if (!t.rows[0]) throw new ExternalTaskError('task_not_found', `Task ${taskId} no existe`, 404);
  const task = t.rows[0];

  // Localizar la task_instance sobre la que actuamos
  let target;
  if (instanceId) {
    const r = await query(
      `SELECT instance_id, employee_id, status
       FROM app.task_instances
       WHERE instance_id = $1 AND task_id = $2`,
      [instanceId, taskId]
    );
    target = r.rows[0];
    if (!target) {
      throw new ExternalTaskError('instance_not_found',
        `instance ${instanceId} no pertenece al task ${taskId}`, 404);
    }
  } else {
    target = await getActiveInstanceForTask(taskId);
    if (!target) {
      throw new ExternalTaskError('no_instance_available',
        `Task ${taskId} no tiene instances materializadas aún. Seteá el status cuando haya instance (ej. cuando la fecha llegue).`, 409);
    }
  }

  // Delegar la transición al core del taskService (valida máquina de estados)
  let result;
  try {
    result = await taskService.setTaskInstanceStatus(target.instance_id, status, {
      employeeId: target.employee_id,
      note,
    });
  } catch (err) {
    if (err instanceof taskService.TaskStatusError) {
      // Re-lanzar como ExternalTaskError para respuesta HTTP coherente
      throw new ExternalTaskError(err.code, err.message, err.httpStatus);
    }
    throw err;
  }

  // Decidir si notificar por Telegram
  const shouldNotify = notify === null ? (NOTIFY_DEFAULTS[status] ?? false) : !!notify;
  let notified = { sent: false, reason: 'not_requested' };
  if (shouldNotify && result.changed) {
    try {
      notified = await _notifyStatusChange({
        task, status, note, employeeId: target.employee_id,
      });
    } catch (err) {
      logger.warn('Notify on setStatus failed', { err: err.message });
      notified = { sent: false, reason: err.message };
    }
  } else if (!result.changed) {
    notified = { sent: false, reason: 'no_change' };
  } else {
    notified = { sent: false, reason: 'notify_opt_out' };
  }

  return {
    task_id: taskId,
    instance_id: target.instance_id,
    status: result.status,
    previous_status: result.previous || target.status,
    changed: result.changed,
    notified: notified.sent,
    notified_reason: notified.reason,
  };
}

async function _notifyStatusChange({ task, status, note, employeeId }) {
  const empRes = await query(
    `SELECT telegram_id, phone_e164 FROM app.employees WHERE employee_id = $1`,
    [employeeId]
  );
  const e = empRes.rows[0];
  if (!e) return { sent: false, reason: 'no_employee' };
  const target = e.telegram_id || e.phone_e164;
  if (!target) return { sent: false, reason: 'no_contact' };

  const emoji = STATUS_EMOJI[status] || '📝';
  const label = STATUS_LABEL[status] || status;
  const lines = [
    `${emoji} Estado actualizado: *${label}*`,
    task.title,
  ];
  if (note) lines.push(`\n${note}`);
  await outboxService.queueMessage(target, lines.join('\n'));
  return { sent: true, reason: 'sent' };
}

// ─── ADD NOTE sin cambio de estado ──────────────────────────────────────────

async function addExternalTaskNote(taskId, { note, notify = false, instanceId = null }) {
  if (!note || !note.trim()) {
    throw new ExternalTaskError('note_required', 'note es requerido', 422);
  }

  const t = await query(`SELECT task_id, title, employee_id FROM app.tasks WHERE task_id = $1`, [taskId]);
  if (!t.rows[0]) throw new ExternalTaskError('task_not_found', `Task ${taskId} no existe`, 404);
  const task = t.rows[0];

  // Localizar instance
  let target;
  if (instanceId) {
    const r = await query(
      `SELECT instance_id, employee_id FROM app.task_instances
       WHERE instance_id = $1 AND task_id = $2`,
      [instanceId, taskId]
    );
    target = r.rows[0];
    if (!target) throw new ExternalTaskError('instance_not_found', `instance ${instanceId} no pertenece al task`, 404);
  } else {
    target = await getActiveInstanceForTask(taskId);
    if (!target) throw new ExternalTaskError('no_instance_available', 'Sin instance activa', 409);
  }

  const r = await query(
    `INSERT INTO app.task_updates (instance_id, employee_id, update_type, note_text)
     VALUES ($1, $2, 'NOTE', $3)
     RETURNING update_id, created_at`,
    [target.instance_id, target.employee_id, note.trim()]
  );

  // Update de last_update_at para que reportes "actividad reciente" lo vean
  await query(
    `UPDATE app.task_instances SET last_update_at = NOW() WHERE instance_id = $1`,
    [target.instance_id]
  );

  let notified = { sent: false, reason: 'not_requested' };
  if (notify) {
    try {
      const empRes = await query(
        `SELECT telegram_id, phone_e164 FROM app.employees WHERE employee_id = $1`,
        [target.employee_id]
      );
      const e = empRes.rows[0];
      const chan = e?.telegram_id || e?.phone_e164;
      if (chan) {
        await outboxService.queueMessage(chan,
          `📝 *Nota agregada al ticket*\n${task.title}\n\n${note.trim()}`);
        notified = { sent: true, reason: 'sent' };
      } else {
        notified = { sent: false, reason: 'no_contact' };
      }
    } catch (err) {
      notified = { sent: false, reason: err.message };
    }
  }

  return {
    task_id: taskId,
    instance_id: target.instance_id,
    update_id: r.rows[0].update_id,
    created_at: r.rows[0].created_at,
    notified: notified.sent,
    notified_reason: notified.reason,
  };
}

// ─── Export ─────────────────────────────────────────────────────────────────

module.exports = {
  ExternalTaskError,
  createExternalTask,
  updateExternalTask,
  cancelExternalTask,
  attachExternalResource,
  setExternalTaskStatus,
  addExternalTaskNote,
  getExternalTask,
  getActiveInstanceForTask,
  findExternalTaskByRef,
  notifyTaskAssigned,
  notifyTaskCanceled,
  notifyTaskUpdated,
};
