const crypto = require('crypto');
const { query, getClient } = require('../config/database');
const logger = require('../utils/logger');

// ─── Time Tracking Helpers ──────────────────────────────────────────────────
// task_time_log tiene un UNIQUE constraint: solo un log abierto por empleado.
// El trigger trg_task_time_log_calc_duration calcula duration_seconds automáticamente.

async function startTimeLog(instanceId, employeeId, client) {
  const q = client ? client.query.bind(client) : query;
  try {
    // Cerrar cualquier log abierto del empleado
    await q(
      `UPDATE task_time_log SET end_ts = NOW() WHERE employee_id = $1 AND end_ts IS NULL`,
      [employeeId]
    );
    // Obtener task_id del instance (para linkear con tarea backlog madre)
    const instRes = await q(
      `SELECT task_id FROM task_instances WHERE instance_id = $1`,
      [instanceId]
    );
    const taskId = instRes.rows[0]?.task_id || null;
    // Abrir nuevo log (con task_id si es backlog)
    await q(
      `INSERT INTO task_time_log (instance_id, task_id, employee_id, start_ts, status_at_time)
       VALUES ($1, $2, $3, NOW(), 'in_progress')`,
      [instanceId, taskId, employeeId]
    );
  } catch (err) {
    // No fallar la operación principal por time tracking
    logger.warn('startTimeLog failed (non-fatal)', { instanceId, employeeId, err: err.message });
  }
}

async function stopTimeLog(employeeId, client) {
  const q = client ? client.query.bind(client) : query;
  try {
    await q(
      `UPDATE task_time_log SET end_ts = NOW() WHERE employee_id = $1 AND end_ts IS NULL`,
      [employeeId]
    );
  } catch (err) {
    logger.warn('stopTimeLog failed (non-fatal)', { employeeId, err: err.message });
  }
}

// Verificar si el empleado tiene un time log abierto y para qué tarea
async function getOpenTimeLog(employeeId) {
  try {
    const res = await query(
      `SELECT instance_id FROM task_time_log WHERE employee_id = $1 AND end_ts IS NULL LIMIT 1`,
      [employeeId]
    );
    return res.rows[0] || null;
  } catch (err) {
    logger.warn('getOpenTimeLog failed (non-fatal)', { employeeId, err: err.message });
    return null;
  }
}

async function getInstanceStatus(instanceId) {
  try {
    const res = await query(
      `SELECT status FROM task_instances WHERE instance_id = $1`,
      [instanceId]
    );
    return res.rows[0]?.status || null;
  } catch (err) {
    logger.warn('getInstanceStatus failed (non-fatal)', { instanceId, err: err.message });
    return null;
  }
}

// Verificar si una tarea repetitiva se completó sospechosamente rápido
// Solo aplica a tareas con template_id (repetitivas), no backlog (task_id).
// Retorna { isFast, elapsedMinutes, standardMinutes } si es rápida, null si normal.
async function checkFastCompletion(instanceId, employeeId) {
  try {
    const instRes = await query(
      `SELECT ti.standard_minutes, ti.task_id, ti.template_id
       FROM task_instances ti WHERE ti.instance_id = $1`,
      [instanceId]
    );
    const inst = instRes.rows[0];
    // Solo repetitivas (template_id, sin task_id) con standard_minutes > 0
    if (!inst || inst.task_id || !inst.template_id || !inst.standard_minutes || inst.standard_minutes <= 0) {
      return null;
    }
    // Buscar time log abierto para esta tarea
    const logRes = await query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - start_ts)) / 60 AS elapsed_minutes
       FROM task_time_log
       WHERE employee_id = $1 AND instance_id = $2 AND end_ts IS NULL
       LIMIT 1`,
      [employeeId, instanceId]
    );
    if (!logRes.rows[0]) return null;
    const elapsed = Math.round(logRes.rows[0].elapsed_minutes);
    const threshold = inst.standard_minutes * 0.5;
    if (elapsed < threshold) {
      return { isFast: true, elapsedMinutes: elapsed, standardMinutes: inst.standard_minutes };
    }
    return null;
  } catch (err) {
    logger.warn('checkFastCompletion failed (non-fatal)', { instanceId, err: err.message });
    return null;
  }
}

// ─── Parent Task Propagation ────────────────────────────────────────────────
// Cuando una task_instance tiene task_id (viene de backlog), propagar cambios
// de estado/progreso a la "tarea madre" en la tabla tasks.
// Non-fatal: errores se loguean pero nunca se propagan.

async function propagateToParentTask(instanceId, opts, client) {
  try {
    const q = client.query.bind(client);

    // 1. Obtener task_id de la instancia
    const instRes = await q(
      `SELECT task_id FROM task_instances WHERE instance_id = $1`, [instanceId]
    );
    const taskId = instRes.rows[0]?.task_id;
    if (!taskId) return; // No parent task → nothing to propagate

    // 2. Obtener estado actual del parent
    const parentRes = await q(
      `SELECT status, progress_percent, started_at FROM tasks WHERE task_id = $1`, [taskId]
    );
    const parent = parentRes.rows[0];
    if (!parent) return;

    const { action, progressPercent, isRelative, blockedReason } = opts;

    switch (action) {
      case 'progress': {
        let newPercent;
        if (isRelative) {
          newPercent = Math.min((parent.progress_percent || 0) + progressPercent, 100);
        } else {
          newPercent = Math.max(parent.progress_percent || 0, progressPercent);
        }

        if (newPercent >= 100) {
          await q(
            `UPDATE tasks SET progress_percent = 100, status = 'done',
                              completed_at = NOW(), updated_at = NOW()
             WHERE task_id = $1`,
            [taskId]
          );
        } else {
          await q(
            `UPDATE tasks SET progress_percent = $1,
                              status = CASE WHEN status = 'backlog' THEN 'in_progress' ELSE status END,
                              started_at = COALESCE(started_at, NOW()),
                              updated_at = NOW()
             WHERE task_id = $2`,
            [newPercent, taskId]
          );
        }
        break;
      }

      case 'done': {
        await q(
          `UPDATE tasks SET status = 'done', progress_percent = 100,
                            completed_at = NOW(), updated_at = NOW()
           WHERE task_id = $1`,
          [taskId]
        );
        break;
      }

      case 'blocked': {
        await q(
          `UPDATE tasks SET status = 'blocked', blocked_reason = $1, updated_at = NOW()
           WHERE task_id = $2`,
          [blockedReason, taskId]
        );
        break;
      }

      case 'start': {
        if (parent.status === 'backlog') {
          await q(
            `UPDATE tasks SET status = 'in_progress',
                              started_at = COALESCE(started_at, NOW()),
                              updated_at = NOW()
             WHERE task_id = $1`,
            [taskId]
          );
        }
        break;
      }

      case 'restart': {
        if (parent.status === 'blocked') {
          await q(
            `UPDATE tasks SET status = 'in_progress', blocked_reason = NULL, updated_at = NOW()
             WHERE task_id = $1`,
            [taskId]
          );
        }
        break;
      }
    }

    logger.info('Propagated to parent task', { taskId, action, progressPercent, isRelative });
  } catch (err) {
    logger.warn('propagateToParentTask failed (non-fatal)', {
      instanceId, action: opts.action, err: err.message,
    });
  }
}

async function getTodayTasksForEmployee(employeeId, workDate, shiftId) {
  // Orden ESTABLE por created_at — los números nunca cambian para el empleado.
  // Las completadas se marcan con ✅ pero conservan su posición original.
  //
  // shiftId (opcional): cuando se pasa, filtra para mostrar SOLO las tareas
  // del turno indicado + las ad-hoc (shift_id IS NULL).
  // Esto evita que un empleado con 2 turnos en el mismo día vea
  // tareas mezcladas de ambos turnos.
  let sql = `SELECT ti.*, tt.title AS template_title, l.name AS location_name
     FROM task_instances ti
     LEFT JOIN task_templates tt ON tt.template_id = ti.template_id
     LEFT JOIN locations l ON l.location_id = ti.location_id
     WHERE ti.employee_id = $1
       AND ti.work_date = $2
       AND ti.status != 'canceled'`;
  const params = [employeeId, workDate];

  if (shiftId) {
    sql += `\n       AND (ti.shift_id = $3 OR ti.shift_id IS NULL)`;
    params.push(shiftId);
  }

  sql += `\n     ORDER BY ti.display_order ASC, ti.created_at ASC`;

  const res = await query(sql, params);
  return res.rows;
}

async function getActiveTask(employeeId, workDate) {
  const res = await query(
    `SELECT ti.*
     FROM task_instances ti
     WHERE ti.employee_id = $1
       AND ti.work_date = $2
       AND ti.status = 'in_progress'
     ORDER BY ti.started_at DESC
     LIMIT 1`,
    [employeeId, workDate]
  );
  return res.rows[0] || null;
}

// Devuelve TODAS las tareas in_progress (no solo la más reciente).
// Útil para detectar el caso "el empleado tiene varias tareas abiertas en paralelo"
// y pedirle que desambigüe antes de marcar alguna como DONE o iniciar otra nueva.
async function getInProgressTasks(employeeId, workDate) {
  const res = await query(
    `SELECT ti.*
     FROM task_instances ti
     WHERE ti.employee_id = $1
       AND ti.work_date = $2
       AND ti.status = 'in_progress'
     ORDER BY ti.started_at DESC`,
    [employeeId, workDate]
  );
  return res.rows;
}

async function findTaskByFuzzyTitle(employeeId, workDate, searchText) {
  const res = await query(
    `SELECT ti.*
     FROM task_instances ti
     WHERE ti.employee_id = $1
       AND ti.work_date = $2
       AND ti.status IN ('planned', 'in_progress', 'blocked')
       AND (
         LOWER(ti.title) LIKE LOWER($3)
         OR LOWER(ti.description) LIKE LOWER($3)
       )
     ORDER BY ti.status = 'in_progress' DESC, ti.created_at ASC
     LIMIT 1`,
    [employeeId, workDate, `%${searchText}%`]
  );
  return res.rows[0] || null;
}

// Same as findTaskByFuzzyTitle but includes done/canceled tasks (for detecting references to completed work)
async function findTaskByTitleAnyStatus(employeeId, workDate, searchText) {
  const res = await query(
    `SELECT ti.*
     FROM task_instances ti
     WHERE ti.employee_id = $1
       AND ti.work_date = $2
       AND ti.status != 'canceled'
       AND (
         LOWER(ti.title) LIKE LOWER($3)
         OR LOWER(ti.description) LIKE LOWER($3)
       )
     ORDER BY
       CASE ti.status WHEN 'in_progress' THEN 1 WHEN 'planned' THEN 2 WHEN 'blocked' THEN 3 WHEN 'done' THEN 4 END,
       ti.created_at ASC
     LIMIT 1`,
    [employeeId, workDate, `%${searchText}%`]
  );
  return res.rows[0] || null;
}

async function updateTaskProgress(instanceId, progressPercent, employeeId, messageId, noteText, options = {}) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { isRelative } = options;
    let effectivePercent = progressPercent;

    // Obtener progreso actual y task_id (para saber si es backlog)
    const curRes = await client.query(
      `SELECT progress_percent, task_id FROM task_instances WHERE instance_id = $1`, [instanceId]
    );
    const current = curRes.rows[0]?.progress_percent || 0;
    const isBacklog = !!curRes.rows[0]?.task_id;

    if (isRelative) {
      // Relativo ("10% más"): sumar al progreso actual
      effectivePercent = Math.min(current + progressPercent, 100);
    } else if (isBacklog && progressPercent < current) {
      // Backlog: no permitir retroceso, interpretar como relativo
      effectivePercent = Math.min(current + progressPercent, 100);
    }

    const isDone = effectivePercent >= 100;
    const newStatus = isDone ? 'done' : 'in_progress';

    await client.query(
      `UPDATE task_instances
       SET progress_percent = $1,
           status = $2,
           started_at = COALESCE(started_at, NOW()),
           completed_at = CASE WHEN $4 THEN NOW() ELSE completed_at END,
           last_update_at = NOW()
       WHERE instance_id = $3`,
      [Math.min(effectivePercent, 100), newStatus, instanceId, isDone]
    );

    await client.query(
      `INSERT INTO task_updates (instance_id, employee_id, message_id, update_type, progress_percent, note_text)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        instanceId,
        employeeId,
        messageId || null,
        isDone ? 'DONE' : 'PROGRESS',
        Math.min(effectivePercent, 100),
        noteText || null,
      ]
    );

    // Propagar a tarea madre (backlog) si existe
    await propagateToParentTask(instanceId, {
      action: isDone ? 'done' : 'progress',
      progressPercent: isRelative ? progressPercent : effectivePercent,
      isRelative,
    }, client);

    // Time tracking: cerrar log cuando tarea se completa O backlog con avance parcial
    // Backlog: cerrar al reportar avance captura el tiempo de la sesión de trabajo diaria
    if (isDone || isBacklog) {
      await stopTimeLog(employeeId, client);
    }

    const autoRelative = !isRelative && isBacklog && progressPercent < current;
    await client.query('COMMIT');
    return { success: true, effectivePercent: Math.min(effectivePercent, 100), autoRelative };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('updateTaskProgress failed', { instanceId, err: err.message });
    throw err;
  } finally {
    client.release();
  }
}

async function markTaskDone(instanceId, employeeId, messageId, noteText) {
  return updateTaskProgress(instanceId, 100, employeeId, messageId, noteText);
}

async function markTaskBlocked(instanceId, employeeId, messageId, blockerText) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE task_instances
       SET status = 'blocked',
           blocked_reason = $1,
           last_update_at = NOW()
       WHERE instance_id = $2`,
      [blockerText, instanceId]
    );

    await client.query(
      `INSERT INTO task_updates (instance_id, employee_id, message_id, update_type, note_text)
       VALUES ($1, $2, $3, 'BLOCKED', $4)`,
      [instanceId, employeeId, messageId || null, blockerText]
    );

    // Propagar bloqueo a tarea madre si existe
    await propagateToParentTask(instanceId, {
      action: 'blocked', blockedReason: blockerText,
    }, client);

    // Time tracking: cerrar log cuando tarea se bloquea
    await stopTimeLog(employeeId, client);

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('markTaskBlocked failed', { instanceId, err: err.message });
    throw err;
  } finally {
    client.release();
  }
}

async function startTask(instanceId, employeeId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE task_instances
       SET status = 'in_progress',
           started_at = COALESCE(started_at, NOW()),
           last_update_at = NOW()
       WHERE instance_id = $1`,
      [instanceId]
    );
    // Propagar inicio a tarea madre si existe (backlog → in_progress)
    await propagateToParentTask(instanceId, { action: 'start' }, client);
    // Time tracking: iniciar log (cierra cualquier log abierto primero)
    await startTimeLog(instanceId, employeeId, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('startTask failed', { instanceId, err: err.message });
    throw err;
  } finally {
    client.release();
  }
}

// Restart a completed task (reset to in_progress with 0%)
async function restartTask(instanceId, employeeId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE task_instances
       SET status = 'in_progress',
           progress_percent = 0,
           started_at = NOW(),
           completed_at = NULL,
           blocked_reason = NULL,
           last_update_at = NOW()
       WHERE instance_id = $1`,
      [instanceId]
    );
    await client.query(
      `INSERT INTO task_updates (instance_id, employee_id, update_type, note_text)
       VALUES ($1, $2, 'START', 'Tarea reiniciada')`,
      [instanceId, employeeId]
    );
    // Propagar reinicio a tarea madre si existe (blocked → in_progress)
    await propagateToParentTask(instanceId, { action: 'restart' }, client);
    // Time tracking: iniciar nuevo log para la tarea reiniciada
    await startTimeLog(instanceId, employeeId, client);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('restartTask failed', { instanceId, err: err.message });
    throw err;
  } finally {
    client.release();
  }
}

async function createAdHocTask(employeeId, workDate, title, description, shiftId, standardMinutes) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const DEFAULT_ADHOC_MINUTES = parseInt(process.env.ADHOC_STANDARD_MINUTES || '30');
    const stdMins = standardMinutes || DEFAULT_ADHOC_MINUTES;
    // Asignar display_order al final de la lista (MAX + 1)
    const orderRes = await client.query(
      `SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order
       FROM task_instances WHERE employee_id = $1 AND work_date = $2`,
      [employeeId, workDate]
    );
    const nextOrder = orderRes.rows[0].next_order;
    const res = await client.query(
      `INSERT INTO task_instances (employee_id, work_date, shift_id, title, description, standard_minutes, status, created_by, started_at, last_update_at, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, 'in_progress', $1, NOW(), NOW(), $7)
       ON CONFLICT (employee_id, work_date, title) DO UPDATE
         SET status = 'in_progress', started_at = COALESCE(task_instances.started_at, NOW()), last_update_at = NOW()
       RETURNING *`,
      [employeeId, workDate, shiftId || null, title, description || null, stdMins, nextOrder]
    );
    // Time tracking: iniciar log para la nueva tarea
    if (res.rows[0]) {
      await startTimeLog(res.rows[0].instance_id, employeeId, client);
    }
    await client.query('COMMIT');
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('createAdHocTask failed', { title, err: err.message });
    throw err;
  } finally {
    client.release();
  }
}

async function generateDailyTaskInstances(employeeId, workDate, shiftId) {
  // ── Fetch templates respecting frequency + weekday_mask ────────────────
  //
  // weekday_mask is a 7-bit bitmask: bit 0 = Sunday, 1 = Mon, ... 6 = Sat
  //   127 (1111111) = every day, 62 (0111110) = Mon-Fri, etc.
  //
  // frequency:
  //   daily/weekly → generate if today matches weekday_mask
  //   monthly      → generate once per month (if not already created this month)
  //   adhoc        → never auto-generate (created manually via "nueva tarea")
  //
  const templates = await query(
    `SELECT tt.*, stt.standard_minutes, stt.frequency, stt.weekday_mask,
            stt.display_order
     FROM shift_task_templates stt
     JOIN task_templates tt ON tt.template_id = stt.template_id
     WHERE stt.shift_id = $1
       AND stt.is_active = true
       AND tt.is_active = true
       -- Exclude ad-hoc tasks (those are created manually)
       AND stt.frequency <> 'adhoc'
       -- Weekday mask check: bit 0=Mon,1=Tue,...,4=Fri,5=Sat,6=Sun
       -- DOW gives 0=Sun, so convert: (DOW+6)%7 → 0=Mon,...,6=Sun
       AND (stt.weekday_mask & (1 << ((EXTRACT(DOW FROM $2::date)::int + 6) % 7))) > 0
       -- Monthly tasks: only if not already generated this calendar month
       AND (
         stt.frequency <> 'monthly'
         OR NOT EXISTS (
           SELECT 1 FROM task_instances ti
           WHERE ti.template_id = stt.template_id
             AND ti.employee_id = $3
             AND ti.work_date >= DATE_TRUNC('month', $2::date)
             AND ti.work_date <  DATE_TRUNC('month', $2::date) + INTERVAL '1 month'
         )
       )
     ORDER BY stt.display_order ASC, tt.title ASC`,
    [shiftId, workDate, employeeId]
  );

  const created = [];
  for (const tmpl of templates.rows) {
    try {
      const res = await query(
        `INSERT INTO task_instances (employee_id, work_date, shift_id, template_id, title, description, standard_minutes, status, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'planned', $8)
         ON CONFLICT (employee_id, work_date, title) DO NOTHING
         RETURNING *`,
        [employeeId, workDate, shiftId, tmpl.template_id, tmpl.title, tmpl.description, tmpl.standard_minutes || tmpl.default_minutes, tmpl.display_order || 0]
      );
      if (res.rows[0]) created.push(res.rows[0]);
    } catch (err) {
      logger.warn('Skipping duplicate task instance', { title: tmpl.title, err: err.message });
    }
  }

  // ── Fase 2: Generar instancias desde tareas de backlog (tasks) ────────────
  // Tareas de largo plazo asignadas al empleado. Filtra por frequency +
  // weekday_mask + task_scheduled_dates según el tipo de programación.
  //
  // frequency behaviour:
  //   daily   → generate if today matches weekday_mask
  //   weekly  → weekday_mask match + no instance this ISO week
  //   monthly → no instance this calendar month
  //   once    → only on due_date, never generated before
  //   adhoc   → only if today is in task_scheduled_dates
  //   (NULL)  → legacy rows → treat as daily/127 (every day)
  try {
    const backlogTasks = await query(
      `SELECT t.*
       FROM tasks t
       WHERE t.employee_id = $1
         AND t.status NOT IN ('done', 'canceled')
         -- Skip tasks whose due_date has already passed
         AND (t.due_date IS NULL OR t.due_date >= $2::date)
         -- No instance for today yet
         AND NOT EXISTS (
           SELECT 1 FROM task_instances ti
           WHERE ti.employee_id = $1
             AND ti.work_date = $2
             AND ti.task_id = t.task_id
         )
         -- Frequency / schedule filter
         AND (
           -- daily (or NULL/legacy): check weekday_mask
           (COALESCE(t.frequency, 'daily') = 'daily'
            AND (COALESCE(t.weekday_mask, 127) & (1 << ((EXTRACT(DOW FROM $2::date)::int + 6) % 7))) > 0)

           -- weekly: weekday_mask + no instance this week
           OR (t.frequency = 'weekly'
               AND (t.weekday_mask & (1 << ((EXTRACT(DOW FROM $2::date)::int + 6) % 7))) > 0
               AND NOT EXISTS (
                 SELECT 1 FROM task_instances ti2
                 WHERE ti2.task_id = t.task_id AND ti2.employee_id = $1
                   AND ti2.work_date >= DATE_TRUNC('week', $2::date)
                   AND ti2.work_date <  DATE_TRUNC('week', $2::date) + INTERVAL '1 week'
               ))

           -- monthly: no instance this calendar month
           OR (t.frequency = 'monthly'
               AND NOT EXISTS (
                 SELECT 1 FROM task_instances ti3
                 WHERE ti3.task_id = t.task_id AND ti3.employee_id = $1
                   AND ti3.work_date >= DATE_TRUNC('month', $2::date)
                   AND ti3.work_date <  DATE_TRUNC('month', $2::date) + INTERVAL '1 month'
               ))

           -- once: only on due_date, never generated before
           OR (t.frequency = 'once'
               AND t.due_date = $2::date
               AND NOT EXISTS (
                 SELECT 1 FROM task_instances ti4
                 WHERE ti4.task_id = t.task_id AND ti4.employee_id = $1
               ))

           -- adhoc: only if today is in task_scheduled_dates
           OR (t.frequency = 'adhoc'
               AND EXISTS (
                 SELECT 1 FROM task_scheduled_dates tsd
                 WHERE tsd.task_id = t.task_id AND tsd.work_date = $2::date
               ))
         )`,
      [employeeId, workDate]
    );

    for (const bt of backlogTasks.rows) {
      try {
        const res = await query(
          `INSERT INTO task_instances
             (employee_id, work_date, shift_id, task_id, title, description,
              standard_minutes, status, progress_percent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'planned', $8)
           ON CONFLICT (employee_id, work_date, title) DO NOTHING
           RETURNING *`,
          [
            employeeId, workDate, shiftId,
            bt.task_id,
            bt.title,
            bt.description,
            bt.planned_minutes || 0,
            bt.progress_percent || 0,  // heredar progreso actual del padre
          ]
        );
        if (res.rows[0]) created.push(res.rows[0]);
      } catch (err) {
        logger.warn('Skipping backlog task instance', {
          taskId: bt.task_id, title: bt.title, err: err.message,
        });
      }
    }
  } catch (err) {
    logger.warn('Backlog task generation failed (non-fatal)', { employeeId, err: err.message });
  }

  if (created.length > 0) {
    logger.info('Task instances generated', {
      employeeId, workDate, shiftId,
      count: created.length,
      titles: created.map(t => t.title),
    });
  }

  return created;
}

function formatTaskList(tasks) {
  if (!tasks || tasks.length === 0) return 'No tienes tareas asignadas para hoy.';

  const statusEmoji = {
    planned: '📋',
    in_progress: '🔄',
    blocked: '🚫',
    done: '✅',
    canceled: '❌',
  };

  let msg = '*Tus tareas para hoy:*\n\n';
  tasks.forEach((t, i) => {
    const emoji = statusEmoji[t.status] || '📋';
    const backlogIcon = t.task_id ? ' 📌' : '';
    const progress = t.progress_percent != null ? ` (${t.progress_percent}%)` : '';
    const location = t.location_name ? ` - ${t.location_name}` : '';
    msg += `${emoji} *${i + 1}.* ${t.title}${backlogIcon}${progress}${location}\n`;
    if (t.status === 'blocked' && t.blocked_reason) {
      msg += `   ⚠️ _Bloqueado: ${t.blocked_reason}_\n`;
    }
  });

  const pending = tasks.filter((t) => t.status === 'planned').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const done = tasks.filter((t) => t.status === 'done').length;

  msg += `\n📊 Resumen: ${done} completadas, ${inProgress} en progreso, ${pending} pendientes`;
  return msg;
}

// ─── Manager: Resumen de tareas de todo el equipo ───────────────────────────
async function getTeamTaskSummary(workDate) {
  const res = await query(
    `SELECT
       e.employee_id,
       e.full_name,
       COUNT(ti.instance_id) AS total_tasks,
       COUNT(CASE WHEN ti.status = 'done' THEN 1 END) AS done_count,
       COUNT(CASE WHEN ti.status = 'in_progress' THEN 1 END) AS in_progress_count,
       COUNT(CASE WHEN ti.status = 'planned' THEN 1 END) AS planned_count,
       COUNT(CASE WHEN ti.status = 'blocked' THEN 1 END) AS blocked_count,
       ROUND(AVG(CASE WHEN ti.status != 'canceled' THEN ti.progress_percent END), 0) AS avg_progress
     FROM employees e
     JOIN task_instances ti ON ti.employee_id = e.employee_id AND ti.work_date = $1
     WHERE e.is_active = true
       AND ti.status != 'canceled'
     GROUP BY e.employee_id, e.full_name
     ORDER BY e.full_name`,
    [workDate]
  );
  return res.rows;
}

// ─── Manager: Reporte de productividad con tiempos reales vs estándar ────────
async function getTeamProductivityReport(workDate) {
  const res = await query(
    `SELECT
       e.employee_id,
       e.full_name,
       COUNT(DISTINCT ti.instance_id) AS total_tasks,
       COUNT(DISTINCT CASE WHEN ti.status = 'done' THEN ti.instance_id END) AS done_count,
       COALESCE(SUM(CASE WHEN ti.status = 'done' THEN ti.standard_minutes ELSE 0 END), 0) AS standard_minutes_done,
       COALESCE(SUM(ti.standard_minutes), 0) AS standard_minutes_total,
       COALESCE(SUM(tl.duration_seconds), 0) AS actual_seconds,
       COUNT(DISTINCT CASE WHEN ti.status = 'blocked' THEN ti.instance_id END) AS blocked_count,
       -- Tiempo en log abierto (tarea en curso)
       COALESCE(
         EXTRACT(EPOCH FROM (NOW() - open_log.start_ts))::INT,
         0
       ) AS current_open_seconds
     FROM employees e
     JOIN task_instances ti ON ti.employee_id = e.employee_id AND ti.work_date = $1
     LEFT JOIN task_time_log tl ON tl.instance_id = ti.instance_id AND tl.end_ts IS NOT NULL
     LEFT JOIN task_time_log open_log ON open_log.employee_id = e.employee_id AND open_log.end_ts IS NULL
     WHERE e.is_active = true
       AND ti.status != 'canceled'
     GROUP BY e.employee_id, e.full_name, open_log.start_ts
     ORDER BY e.full_name`,
    [workDate]
  );
  return res.rows;
}

async function getEmployeeTimeDetail(employeeId, workDate) {
  const res = await query(
    `SELECT
       ti.instance_id,
       ti.title,
       ti.status,
       ti.standard_minutes,
       ti.progress_percent,
       COALESCE(SUM(tl.duration_seconds), 0) AS actual_seconds,
       COUNT(tl.log_id) AS log_entries,
       -- Si hay log abierto para esta tarea, sumar tiempo en curso
       MAX(CASE WHEN tl.end_ts IS NULL THEN EXTRACT(EPOCH FROM (NOW() - tl.start_ts))::INT ELSE 0 END) AS open_seconds
     FROM task_instances ti
     LEFT JOIN task_time_log tl ON tl.instance_id = ti.instance_id
     WHERE ti.employee_id = $1
       AND ti.work_date = $2
       AND ti.status != 'canceled'
     GROUP BY ti.instance_id, ti.title, ti.status, ti.standard_minutes, ti.progress_percent, ti.display_order
     ORDER BY
       CASE ti.status WHEN 'in_progress' THEN 1 WHEN 'planned' THEN 2 WHEN 'blocked' THEN 3 WHEN 'done' THEN 4 END,
       ti.display_order ASC, ti.created_at ASC`,
    [employeeId, workDate]
  );
  return res.rows;
}

async function updateStandardMinutes(instanceId, minutes) {
  await query(
    `UPDATE task_instances SET standard_minutes = $1, last_update_at = NOW() WHERE instance_id = $2`,
    [minutes, instanceId]
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECKLIST / RESOURCES / MOBILE TOKEN
// ═══════════════════════════════════════════════════════════════════════════════

const TOKEN_EXPIRY_HOURS = parseInt(process.env.TOKEN_EXPIRY_HOURS || '24');
const MOBILE_BASE_URL = (process.env.MOBILE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

/**
 * Copia checklist items de la plantilla (task_checklist_items) a la instancia.
 */
async function copyChecklistToInstance(instanceId, taskId, client) {
  const q = client ? client.query.bind(client) : query;
  const items = await q(
    `SELECT checklist_item_id, sort_order, title, description, help_text,
            help_image_url, help_video_url, is_required, requires_photo,
            requires_note, estimated_minutes
     FROM task_checklist_items
     WHERE task_id = $1 AND is_active = true
     ORDER BY sort_order`,
    [taskId]
  );
  let count = 0;
  for (const item of items.rows) {
    await q(
      `INSERT INTO task_instance_checklist
         (instance_id, checklist_item_id, sort_order, title, description,
          help_text, help_image_url, help_video_url, is_required,
          requires_photo, requires_note, estimated_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [instanceId, item.checklist_item_id, item.sort_order, item.title,
       item.description, item.help_text, item.help_image_url,
       item.help_video_url, item.is_required, item.requires_photo,
       item.requires_note, item.estimated_minutes]
    );
    count++;
  }
  return count;
}

/**
 * Copia recursos requeridos de la plantilla (task_required_resources) a la instancia.
 */
async function copyResourcesToInstance(instanceId, taskId, client) {
  const q = client ? client.query.bind(client) : query;
  const items = await q(
    `SELECT task_resource_id, sort_order, resource_type, resource_name,
            description, quantity, unit, estimated_use_minutes,
            is_required, acquisition
     FROM task_required_resources
     WHERE task_id = $1
     ORDER BY sort_order`,
    [taskId]
  );
  let count = 0;
  for (const item of items.rows) {
    await q(
      `INSERT INTO task_instance_resources
         (instance_id, task_resource_id, sort_order, resource_type,
          resource_name, description, quantity, unit,
          estimated_use_minutes, is_required, acquisition)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [instanceId, item.task_resource_id, item.sort_order,
       item.resource_type, item.resource_name, item.description,
       item.quantity, item.unit, item.estimated_use_minutes,
       item.is_required, item.acquisition]
    );
    count++;
  }
  return count;
}

/**
 * Obtiene la frequency de la tarea madre (backlog) de una instancia.
 * Retorna 'daily'|'once'|'adhoc'|'weekly'|'monthly' o null si no es backlog.
 */
async function getTaskFrequency(taskId) {
  if (!taskId) return null;
  try {
    const res = await query(
      `SELECT frequency FROM tasks WHERE task_id = $1`,
      [taskId]
    );
    return res.rows[0]?.frequency || null;
  } catch (err) {
    logger.warn('getTaskFrequency failed (non-fatal)', { taskId, err: err.message });
    return null;
  }
}

/**
 * Obtiene el equipo asignado a una tarea (via tasks.team_id → teams).
 * Resuelve member1..member6 a full_name de employees.
 * Retorna { teamName, members: [{ name }] } o null si no tiene team.
 */
async function getTaskTeam(taskId) {
  if (!taskId) return null;
  try {
    const res = await query(
      `SELECT t.team_name,
              e1.full_name AS m1, e2.full_name AS m2, e3.full_name AS m3,
              e4.full_name AS m4, e5.full_name AS m5, e6.full_name AS m6
       FROM tasks tk
       JOIN teams t ON t.team_id = tk.team_id
       LEFT JOIN employees e1 ON t.member1 = e1.employee_id
       LEFT JOIN employees e2 ON t.member2 = e2.employee_id
       LEFT JOIN employees e3 ON t.member3 = e3.employee_id
       LEFT JOIN employees e4 ON t.member4 = e4.employee_id
       LEFT JOIN employees e5 ON t.member5 = e5.employee_id
       LEFT JOIN employees e6 ON t.member6 = e6.employee_id
       WHERE tk.task_id = $1`,
      [taskId]
    );
    if (!res.rows[0]) return null;
    const row = res.rows[0];
    const members = [row.m1, row.m2, row.m3, row.m4, row.m5, row.m6]
      .filter(Boolean)
      .map(name => ({ name }));
    return { teamName: row.team_name, members };
  } catch (err) {
    logger.warn('getTaskTeam failed (non-fatal)', { taskId, err: err.message });
    return null;
  }
}

/**
 * Genera un token de acceso móvil para una instancia.
 * Retorna el token string (64 hex chars).
 */
async function generateAccessToken(instanceId, employeeId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO task_instance_access_tokens (instance_id, employee_id, token, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '${TOKEN_EXPIRY_HOURS} hours')`,
    [instanceId, employeeId, token]
  );
  return token;
}

/**
 * Valida un token y retorna datos de la instancia y empleado.
 * Retorna null si token inválido, expirado o revocado.
 */
async function getTaskByToken(token) {
  if (!token || token.length < 10) return null;
  const res = await query(
    `SELECT
       t.token_id, t.instance_id, t.employee_id, t.expires_at,
       ti.title, ti.description, ti.status, ti.progress_percent,
       ti.standard_minutes, ti.work_date, ti.started_at, ti.task_id,
       e.full_name AS employee_name
     FROM task_instance_access_tokens t
     JOIN task_instances ti ON ti.instance_id = t.instance_id
     JOIN employees e ON e.employee_id = t.employee_id
     WHERE t.token = $1
       AND t.revoked = false
       AND t.expires_at > NOW()`,
    [token]
  );
  if (!res.rows[0]) return null;
  // Actualizar last_accessed_at (fire-and-forget)
  query(
    `UPDATE task_instance_access_tokens SET last_accessed_at = NOW() WHERE token = $1`,
    [token]
  ).catch(() => {});
  const row = res.rows[0];
  return {
    tokenId: row.token_id,
    instance: {
      instanceId: row.instance_id,
      taskId: row.task_id,
      title: row.title,
      description: row.description,
      status: row.status,
      progressPercent: row.progress_percent,
      standardMinutes: row.standard_minutes,
      workDate: row.work_date,
      startedAt: row.started_at,
    },
    employee: {
      employeeId: row.employee_id,
      fullName: row.employee_name,
    },
  };
}

/**
 * Obtiene los checklist items de una instancia.
 */
async function getInstanceChecklist(instanceId) {
  const res = await query(
    `SELECT instance_checklist_id AS id, sort_order, title, description,
            help_text, help_image_url, help_video_url,
            is_required, requires_photo, requires_note,
            estimated_minutes, status, completed_at,
            note_text, photo_url
     FROM task_instance_checklist
     WHERE instance_id = $1
     ORDER BY sort_order`,
    [instanceId]
  );
  return res.rows;
}

/**
 * Obtiene los recursos de una instancia.
 */
async function getInstanceResources(instanceId) {
  const res = await query(
    `SELECT instance_resource_id AS id, sort_order, resource_type,
            resource_name, description, quantity, unit,
            estimated_use_minutes, is_required, acquisition,
            confirmed, confirmed_at, notes
     FROM task_instance_resources
     WHERE instance_id = $1
     ORDER BY sort_order`,
    [instanceId]
  );
  return res.rows;
}

/**
 * Actualiza un item del checklist de instancia.
 */
async function updateChecklistItem(itemId, updates, employeeId) {
  const { status, note, photoUrl } = updates;
  const sets = ['updated_at = NOW()'];
  const params = [];
  let idx = 1;

  if (status) {
    sets.push(`status = $${idx++}`);
    params.push(status);
    if (status === 'done' || status === 'skipped') {
      sets.push(`completed_at = NOW()`);
      sets.push(`completed_by = $${idx++}`);
      params.push(employeeId);
    }
  }
  if (note !== undefined) {
    sets.push(`note_text = $${idx++}`);
    params.push(note);
  }
  if (photoUrl !== undefined) {
    sets.push(`photo_url = $${idx++}`);
    params.push(photoUrl);
  }

  params.push(itemId);
  const res = await query(
    `UPDATE task_instance_checklist SET ${sets.join(', ')}
     WHERE instance_checklist_id = $${idx}
     RETURNING *`,
    params
  );
  return res.rows[0] || null;
}

/**
 * Confirma o deniega un recurso de instancia.
 */
async function confirmResource(resourceId, confirmed, employeeId, notes) {
  const res = await query(
    `UPDATE task_instance_resources
     SET confirmed = $1,
         confirmed_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
         confirmed_by = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
         notes = COALESCE($3, notes),
         updated_at = NOW()
     WHERE instance_resource_id = $4
     RETURNING *`,
    [confirmed, employeeId, notes, resourceId]
  );
  return res.rows[0] || null;
}

/**
 * Calcula progreso del checklist de una instancia.
 */
async function getChecklistProgress(instanceId) {
  const res = await query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'done')::int AS done,
       COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE is_required)::int AS required_total,
       COUNT(*) FILTER (WHERE is_required AND status = 'done')::int AS required_done
     FROM task_instance_checklist
     WHERE instance_id = $1`,
    [instanceId]
  );
  const row = res.rows[0] || { total: 0, done: 0, skipped: 0, pending: 0, required_total: 0, required_done: 0 };
  return {
    total: row.total,
    done: row.done,
    skipped: row.skipped,
    pending: row.pending,
    requiredTotal: row.required_total,
    requiredDone: row.required_done,
    allRequiredDone: row.required_total > 0 && row.required_done >= row.required_total,
  };
}

/**
 * Post-procesamiento después de startTask:
 * Si la tarea tiene requires_checklist/requires_resources,
 * copia datos de plantilla y genera token de acceso móvil.
 * Retorna { link, hasChecklist, hasResources } o null si no aplica.
 */
async function postStartEnrichment(instanceId, employeeId) {
  // Obtener task_id de la instancia
  const instRes = await query(
    `SELECT task_id FROM task_instances WHERE instance_id = $1`,
    [instanceId]
  );
  const taskId = instRes.rows[0]?.task_id;
  if (!taskId) return null; // No es tarea de backlog → no aplica

  // Verificar flags en la tarea madre
  const taskRes = await query(
    `SELECT requires_checklist, requires_resources FROM tasks WHERE task_id = $1`,
    [taskId]
  );
  const task = taskRes.rows[0];
  if (!task) return null;

  const hasChecklist = task.requires_checklist === true;
  const hasResources = task.requires_resources === true;
  if (!hasChecklist && !hasResources) return null;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Limpiar datos previos (por si es restart)
    await client.query(`DELETE FROM task_instance_checklist WHERE instance_id = $1`, [instanceId]);
    await client.query(`DELETE FROM task_instance_resources WHERE instance_id = $1`, [instanceId]);
    await client.query(
      `UPDATE task_instance_access_tokens SET revoked = true
       WHERE instance_id = $1 AND revoked = false`,
      [instanceId]
    );

    // Copiar datos de plantilla
    let checklistCount = 0;
    let resourceCount = 0;
    if (hasChecklist) {
      checklistCount = await copyChecklistToInstance(instanceId, taskId, client);
    }
    if (hasResources) {
      resourceCount = await copyResourcesToInstance(instanceId, taskId, client);
    }

    await client.query('COMMIT');

    // Generar token de acceso (fuera de transacción — non-critical)
    const token = await generateAccessToken(instanceId, employeeId);
    const link = `${MOBILE_BASE_URL}/m/task/${token}`;

    logger.info('postStartEnrichment completed', {
      instanceId, taskId, hasChecklist, hasResources,
      checklistCount, resourceCount,
    });

    return { link, hasChecklist, hasResources, checklistCount, resourceCount };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('postStartEnrichment failed', { instanceId, err: err.message });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Agrega una foto a un checklist item (tabla de fotos múltiples).
 */
async function addChecklistPhoto(checklistItemId, fileUrl, fileName, fileSize, employeeId) {
  // Get next sort_order
  const orderRes = await query(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
     FROM task_instance_checklist_photos
     WHERE instance_checklist_id = $1`,
    [checklistItemId]
  );
  const sortOrder = orderRes.rows[0]?.next_order || 1;

  const res = await query(
    `INSERT INTO task_instance_checklist_photos
       (instance_checklist_id, file_url, file_name, file_size, sort_order, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [checklistItemId, fileUrl, fileName, fileSize, sortOrder, employeeId]
  );
  return res.rows[0] || null;
}

/**
 * Elimina una foto de checklist por photo_id.
 * Retorna la foto eliminada (para borrar el archivo físico).
 */
async function deleteChecklistPhoto(photoId) {
  const res = await query(
    `DELETE FROM task_instance_checklist_photos
     WHERE photo_id = $1
     RETURNING *`,
    [photoId]
  );
  return res.rows[0] || null;
}

/**
 * Obtiene las fotos de múltiples checklist items.
 * Retorna un mapa: { checklistItemId: [photos] }
 */
async function getChecklistPhotos(checklistItemIds) {
  if (!checklistItemIds || checklistItemIds.length === 0) return {};
  const res = await query(
    `SELECT photo_id, instance_checklist_id, file_url, file_name, file_size,
            sort_order, created_at
     FROM task_instance_checklist_photos
     WHERE instance_checklist_id = ANY($1)
     ORDER BY instance_checklist_id, sort_order`,
    [checklistItemIds]
  );
  const map = {};
  for (const row of res.rows) {
    const key = row.instance_checklist_id;
    if (!map[key]) map[key] = [];
    map[key].push(row);
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPERVISOR TASK ASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════════════

const ASSIGN_TOKEN_EXPIRY_HOURS = parseInt(process.env.ASSIGN_TOKEN_EXPIRY_HOURS || '2');

async function generateSupervisorAssignmentToken(supervisorId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO supervisor_assignment_tokens (supervisor_id, token, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour' * $3)`,
    [supervisorId, token, ASSIGN_TOKEN_EXPIRY_HOURS]
  );
  return token;
}

async function getAssignmentTokenData(token) {
  if (!token || token.length < 10) return null;
  const res = await query(
    `SELECT t.token_id, t.supervisor_id, t.expires_at,
            e.full_name AS supervisor_name
     FROM supervisor_assignment_tokens t
     JOIN employees e ON e.employee_id = t.supervisor_id
     WHERE t.token = $1
       AND t.used = false
       AND t.expires_at > NOW()`,
    [token]
  );
  return res.rows[0] || null;
}

async function createSupervisorAssignedTask(token, formData) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Verify token still valid
    const tokenRes = await client.query(
      `SELECT * FROM supervisor_assignment_tokens
       WHERE token = $1 AND used = false AND expires_at > NOW()
       FOR UPDATE`,
      [token]
    );
    if (!tokenRes.rows[0]) throw new Error('Token inválido o expirado');
    const tokenData = tokenRes.rows[0];

    // Create app.tasks record
    const taskRes = await client.query(
      `INSERT INTO tasks (
         employee_id, project_id, title, description, priority,
         planned_minutes, status, due_date, assigned_by, created_by,
         frequency, weekday_mask, team_id
       ) VALUES ($1, $2, $3, $4, $5, $6, 'backlog', $7, $8, $8, 'once', 0, $9)
       RETURNING *`,
      [
        formData.employee_id,
        formData.project_id || null,
        formData.title,
        formData.description || null,
        formData.priority || 3,
        formData.planned_minutes || 30,
        formData.due_date,
        tokenData.supervisor_id,
        formData.team_id || null,
      ]
    );
    const task = taskRes.rows[0];

    let instance = null;
    const { getTodayDate } = require('../utils/dateHelper');
    const today = getTodayDate();

    if (formData.due_date === today) {
      // Get employee shift for today
      const shiftRes = await client.query(
        `SELECT sa.shift_id FROM shift_assignments sa
         WHERE sa.employee_id = $1 AND sa.work_date = $2 LIMIT 1`,
        [formData.employee_id, today]
      );
      const shiftId = shiftRes.rows[0]?.shift_id || null;

      // Get next display_order
      const orderRes = await client.query(
        `SELECT COALESCE(MAX(display_order), 0) + 1 AS next_order
         FROM task_instances WHERE employee_id = $1 AND work_date = $2`,
        [formData.employee_id, today]
      );

      const instRes = await client.query(
        `INSERT INTO task_instances (
           employee_id, work_date, shift_id, task_id, title, description,
           standard_minutes, status, display_order, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'planned', $8, $9)
         RETURNING *`,
        [
          formData.employee_id, today, shiftId, task.task_id,
          formData.title, formData.description || null,
          formData.planned_minutes || 30,
          orderRes.rows[0].next_order,
          tokenData.supervisor_id,
        ]
      );
      instance = instRes.rows[0];
    }

    // Mark token as used
    await client.query(
      `UPDATE supervisor_assignment_tokens SET used = true, created_task_id = $1 WHERE token = $2`,
      [task.task_id, token]
    );

    await client.query('COMMIT');
    return { task, instance };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getAllActiveEmployees() {
  const res = await query(
    `SELECT employee_id, full_name FROM employees WHERE is_active = true ORDER BY full_name`
  );
  return res.rows;
}

async function getAllActiveProjects() {
  const res = await query(
    `SELECT project_id, project_name FROM projects WHERE is_active = true ORDER BY project_name`
  );
  return res.rows;
}

async function getAllTeams() {
  const res = await query(
    `SELECT team_id, team_name FROM teams ORDER BY team_name`
  );
  return res.rows;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ESCALATION FORM TOKENS (supervisor_auditor)
// ═══════════════════════════════════════════════════════════════════════════════

const ESCALATION_TOKEN_EXPIRY_HOURS = parseInt(process.env.ESCALATION_TOKEN_EXPIRY_HOURS || '48');

async function generateEscalationToken(escalationId, supervisorId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO escalation_access_tokens (escalation_id, supervisor_id, token, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour' * $4)`,
    [escalationId, supervisorId, token, ESCALATION_TOKEN_EXPIRY_HOURS]
  );
  return token;
}

async function getEscalationByToken(token) {
  if (!token || token.length < 10) return null;
  const res = await query(
    `SELECT t.token_id, t.escalation_id, t.supervisor_id, t.expires_at,
            e.escalation_id AS esc_id, e.employee_id, e.supervisor_id AS esc_supervisor_id,
            e.work_date, e.reason, e.inbound_text, e.created_at AS escalation_created_at,
            e.requires_form, e.contacto_empleado, e.instrucciones_dadas,
            e.nota_adicional, e.resuelto, e.form_opened_at, e.resolved_at,
            emp.full_name AS employee_name, emp.phone_e164 AS employee_phone,
            sup.full_name AS supervisor_name
     FROM escalation_access_tokens t
     JOIN supervisor_escalations e ON e.escalation_id = t.escalation_id
     JOIN employees emp ON emp.employee_id = e.employee_id
     JOIN employees sup ON sup.employee_id = t.supervisor_id
     WHERE t.token = $1
       AND t.revoked = false
       AND t.expires_at > NOW()`,
    [token]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];

  // Mark first access timestamp
  if (!row.form_opened_at) {
    await query(
      `UPDATE supervisor_escalations SET form_opened_at = NOW() WHERE escalation_id = $1`,
      [row.escalation_id]
    );
  }

  return row;
}

async function updateEscalationForm(escalationId, data) {
  const { contacto_empleado, instrucciones_dadas, nota_adicional, resuelto } = data;

  // If resolving, set resolved_at timestamp
  const resolvedClause = resuelto === 'si'
    ? `, resolved_at = COALESCE(resolved_at, NOW())`
    : '';

  // If first update, set form_opened_at
  const openedClause = `, form_opened_at = COALESCE(form_opened_at, NOW())`;

  await query(
    `UPDATE supervisor_escalations
     SET contacto_empleado = $2,
         instrucciones_dadas = $3,
         nota_adicional = $4,
         resuelto = $5
         ${openedClause}
         ${resolvedClause}
     WHERE escalation_id = $1`,
    [escalationId, contacto_empleado, instrucciones_dadas, nota_adicional, resuelto]
  );
}

module.exports = {
  getTodayTasksForEmployee,
  getActiveTask,
  getInProgressTasks,
  findTaskByFuzzyTitle,
  findTaskByTitleAnyStatus,
  updateTaskProgress,
  markTaskDone,
  markTaskBlocked,
  startTask,
  restartTask,
  createAdHocTask,
  generateDailyTaskInstances,
  formatTaskList,
  getTeamTaskSummary,
  getTeamProductivityReport,
  getEmployeeTimeDetail,
  stopTimeLog,
  getOpenTimeLog,
  getInstanceStatus,
  checkFastCompletion,
  updateStandardMinutes,
  // Checklist / Resources / Mobile
  copyChecklistToInstance,
  copyResourcesToInstance,
  generateAccessToken,
  getTaskByToken,
  getInstanceChecklist,
  getInstanceResources,
  updateChecklistItem,
  confirmResource,
  getChecklistProgress,
  postStartEnrichment,
  addChecklistPhoto,
  deleteChecklistPhoto,
  getChecklistPhotos,
  getTaskFrequency,
  getTaskTeam,
  // Supervisor assignment
  generateSupervisorAssignmentToken,
  getAssignmentTokenData,
  createSupervisorAssignedTask,
  getAllActiveEmployees,
  getAllActiveProjects,
  getAllTeams,
  // Escalation form (supervisor_auditor)
  generateEscalationToken,
  getEscalationByToken,
  updateEscalationForm,
};
