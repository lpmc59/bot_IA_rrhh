const cron = require('node-cron');
const logger = require('../utils/logger');
const { getTodayDate } = require('../utils/dateHelper');
const { query } = require('../config/database');
const outboxService = require('../services/outboxService');
const taskService = require('../services/taskService');

// ─── Configuración ──────────────────────────────────────────────────────────
const NO_CHECKIN_MINUTES = parseInt(process.env.ALERT_NO_CHECKIN_MINUTES || '60');
const NO_TASK_MINUTES = parseInt(process.env.ALERT_NO_TASK_MINUTES || '60');
const OVERTIME_FACTOR = parseFloat(process.env.ALERT_OVERTIME_FACTOR || '2');
// Minutos de gracia después del fin de turno para seguir monitoreando actividad.
// 0 = no alertar una vez terminado el turno (comportamiento estricto, recomendado).
// >0 = dejar N minutos extra por si el empleado está cerrando tareas o haciendo wrap-up.
const SHIFT_END_GRACE_MINUTES = parseInt(process.env.ALERT_SHIFT_END_GRACE_MINUTES || '0');
// Minutos a esperar después del fin de turno antes de reportar tareas sin cerrar.
// Da tiempo al empleado a cerrar tareas pendientes antes de molestar al supervisor.
const OPEN_TASKS_END_GRACE_MINUTES = parseInt(process.env.ALERT_OPEN_TASKS_END_GRACE_MINUTES || '15');

// ─── Cron principal: cada 15 minutos ────────────────────────────────────────
function startSupervisorAlertsCron() {
  cron.schedule('*/15 * * * *', async () => {
    try {
      await runAllAlerts();
    } catch (err) {
      logger.error('Supervisor alerts cron failed', { err: err.message });
    }
  });

  logger.info(`Supervisor alerts cron started (no-checkin: ${NO_CHECKIN_MINUTES}m, no-task: ${NO_TASK_MINUTES}m, shift-end-grace: ${SHIFT_END_GRACE_MINUTES}m, open-tasks-end-grace: ${OPEN_TASKS_END_GRACE_MINUTES}m, overtime: ${OVERTIME_FACTOR}x)`);
}

async function runAllAlerts() {
  const workDate = getTodayDate();
  const results = await Promise.allSettled([
    alertNoCheckin(workDate),
    alertNoTaskInProgress(workDate),
    alertTaskOvertime(workDate),
    alertOpenTasksAtShiftEnd(workDate),
  ]);

  for (const r of results) {
    if (r.status === 'rejected') {
      logger.error('Supervisor alert sub-task failed', { err: r.reason?.message });
    }
  }
}

// ─── Alerta 1: Sin check-in después de N minutos ───────────────────────────
// Empleado con turno asignado, turno empezó hace >1h, sin checkin respondido.
async function alertNoCheckin(workDate) {
  const res = await query(
    `SELECT sa.employee_id, e.full_name, e.phone_e164, e.telegram_id,
            st.start_time, st.shift_code, st.shift_name,
            sup.employee_id AS supervisor_id, sup.full_name AS supervisor_name,
            sup.phone_e164 AS supervisor_phone, sup.telegram_id AS supervisor_telegram_id,
            sup.role AS supervisor_role
     FROM shift_assignments sa
     JOIN shift_templates st ON st.shift_id = sa.shift_id
     JOIN employees e ON e.employee_id = sa.employee_id
     LEFT JOIN employees sup ON sup.employee_id = e.supervisor_id
     LEFT JOIN shift_calendar sc ON sc.shift_id = sa.shift_id AND sc.work_date = sa.work_date
     WHERE sa.work_date = $1
       AND st.is_active = true
       AND e.is_active = true
       -- Turno empezó hace más de N minutos
       AND NOW() > (CURRENT_DATE + st.start_time + ($2 || ' minutes')::interval)
       -- No tiene checkin respondido
       AND NOT EXISTS (
         SELECT 1 FROM checkins c
         WHERE c.employee_id = sa.employee_id
           AND c.work_date = $1
           AND c.checkin_type = 'start_day'
           AND c.status = 'answered'
       )
       -- No se ha notificado ya por esta razón hoy
       AND NOT EXISTS (
         SELECT 1 FROM supervisor_escalations esc
         WHERE esc.employee_id = sa.employee_id
           AND esc.work_date = $1
           AND esc.reason = 'NO_CHECKIN_1H'
       )`,
    [workDate, NO_CHECKIN_MINUTES]
  );

  for (const emp of res.rows) {
    const startHHMM = emp.start_time.substring(0, 5);
    const notifMsg = `🚨 *Sin check-in*\nEmpleado: ${emp.full_name}\nTurno: ${emp.shift_code || emp.shift_name} (inicio: ${startHHMM})\nHa pasado más de ${NO_CHECKIN_MINUTES} min y no se ha reportado.`;

    const formLink = await insertEscalation(emp.employee_id, emp.supervisor_id, workDate, 'NO_CHECKIN_1H', notifMsg, emp.supervisor_role);

    if (emp.supervisor_telegram_id || emp.supervisor_phone) {
      await outboxService.queueMessage(emp.supervisor_telegram_id || emp.supervisor_phone, notifMsg + formLink);
      logger.info('Alert NO_CHECKIN_1H sent', { employee: emp.full_name, supervisor: emp.supervisor_name });
    }

    // Also notify all general supervisors (sin link de formulario)
    await outboxService.notifyGeneralSupervisors(notifMsg);
  }
}

// ─── Alerta 2: Sin tarea en progreso después de N minutos ───────────────────
// Empleado hizo check-in hace >1h pero no tiene ninguna tarea in_progress.
async function alertNoTaskInProgress(workDate) {
  const res = await query(
    `SELECT e.employee_id, e.full_name,
            c.answered_ts,
            st.start_time AS shift_start_time,
            st.end_time   AS shift_end_time,
            st.shift_code, st.shift_name,
            -- Última actividad registrada hoy (para el mensaje al supervisor)
            (SELECT GREATEST(
                      COALESCE(MAX(ti.last_update_at), 'epoch'::timestamptz),
                      COALESCE(MAX(ti.completed_at),   'epoch'::timestamptz))
             FROM task_instances ti
             WHERE ti.employee_id = e.employee_id
               AND ti.work_date = $1) AS last_activity_ts,
            (SELECT ti.title
             FROM task_instances ti
             WHERE ti.employee_id = e.employee_id
               AND ti.work_date = $1
               AND ti.completed_at IS NOT NULL
             ORDER BY ti.completed_at DESC LIMIT 1) AS last_task_title,
            sup.employee_id AS supervisor_id, sup.full_name AS supervisor_name,
            sup.phone_e164 AS supervisor_phone, sup.telegram_id AS supervisor_telegram_id,
            sup.role AS supervisor_role
     FROM checkins c
     JOIN employees e ON e.employee_id = c.employee_id
     -- Solo consideramos empleados con turno asignado hoy.
     -- Esto permite verificar el end_time del turno y no alertar fuera de horario.
     JOIN shift_assignments sa ON sa.employee_id = e.employee_id AND sa.work_date = $1
     JOIN shift_templates    st ON st.shift_id  = sa.shift_id AND st.is_active = true
     LEFT JOIN employees sup ON sup.employee_id = e.supervisor_id
     WHERE c.work_date = $1
       AND c.checkin_type = 'start_day'
       AND c.status = 'answered'
       AND e.is_active = true
       -- Check-in fue hace más de N minutos
       AND NOW() > c.answered_ts + ($2 || ' minutes')::interval
       -- El turno NO ha terminado (con grace opcional). Si el turno ya terminó,
       -- no tiene sentido alertar "sin tarea en progreso" — el empleado ya salió.
       -- Turnos que cruzan medianoche (end_time < start_time) se manejan sumando un día.
       AND NOW() < (
             CASE
               WHEN st.end_time <= st.start_time THEN
                 -- Turno nocturno: end_time es al día siguiente
                 (CURRENT_DATE + INTERVAL '1 day' + st.end_time
                    + ($3 || ' minutes')::interval)
               ELSE
                 (CURRENT_DATE + st.end_time
                    + ($3 || ' minutes')::interval)
             END
           )
       -- No ha habido actividad de tarea en los últimos N minutos.
       -- "Actividad" = tarea in_progress, o task_instance actualizada/completada recientemente.
       -- Esto evita falsos positivos cuando el empleado termina una rutinaria y tarda
       -- unos minutos en reportar una nueva tarea (ad-hoc) desde Telegram: la ventana
       -- de transición entre la última rutinaria cerrada y la nueva ad-hoc creada ya
       -- no dispara la alerta, siempre que la actividad esté dentro de N minutos.
       -- También cubre tareas nuevas/backlog porque las ad-hoc van al mismo task_instances
       -- con status='in_progress' (ver taskService.createAdHocTask).
       AND NOT EXISTS (
         SELECT 1 FROM task_instances ti
         WHERE ti.employee_id = e.employee_id
           AND ti.work_date = $1
           AND (
             ti.status = 'in_progress'
             OR ti.last_update_at > NOW() - ($2 || ' minutes')::interval
             OR ti.completed_at  > NOW() - ($2 || ' minutes')::interval
           )
       )
       -- No tiene TODAS las tareas completadas (si terminó todo, no alertar)
       AND EXISTS (
         SELECT 1 FROM task_instances ti
         WHERE ti.employee_id = e.employee_id
           AND ti.work_date = $1
           AND ti.status IN ('planned', 'blocked')
       )
       -- No se ha notificado ya por esta razón hoy
       AND NOT EXISTS (
         SELECT 1 FROM supervisor_escalations esc
         WHERE esc.employee_id = e.employee_id
           AND esc.work_date = $1
           AND esc.reason = 'NO_TASK_1H'
       )`,
    [workDate, NO_TASK_MINUTES, SHIFT_END_GRACE_MINUTES]
  );

  for (const emp of res.rows) {
    const checkinTime = new Date(emp.answered_ts).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', hour12: false });
    // Detalle de inactividad: si nunca registró actividad vs cuánto hace que terminó algo
    let activityDetail = '';
    if (emp.last_activity_ts && new Date(emp.last_activity_ts).getTime() > 0) {
      const activityTime = new Date(emp.last_activity_ts).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', hour12: false });
      const minsAgo = Math.round((Date.now() - new Date(emp.last_activity_ts).getTime()) / 60000);
      if (emp.last_task_title) {
        activityDetail = `\nÚltima actividad: *${emp.last_task_title}* a las ${activityTime} (hace ${minsAgo} min)`;
      } else {
        activityDetail = `\nÚltima actividad registrada: ${activityTime} (hace ${minsAgo} min)`;
      }
    } else {
      activityDetail = `\nNo ha registrado ninguna actividad de tarea desde el check-in.`;
    }
    const notifMsg = `⚠️ *Sin tarea en progreso*\nEmpleado: ${emp.full_name}\nHizo check-in a las ${checkinTime} y no tiene actividad en los últimos ${NO_TASK_MINUTES} min.${activityDetail}`;

    const formLink = await insertEscalation(emp.employee_id, emp.supervisor_id, workDate, 'NO_TASK_1H', notifMsg, emp.supervisor_role);

    if (emp.supervisor_telegram_id || emp.supervisor_phone) {
      await outboxService.queueMessage(emp.supervisor_telegram_id || emp.supervisor_phone, notifMsg + formLink);
      logger.info('Alert NO_TASK_1H sent', { employee: emp.full_name, supervisor: emp.supervisor_name });
    }

    // Also notify all general supervisors (sin link de formulario)
    await outboxService.notifyGeneralSupervisors(notifMsg);
  }
}

// ─── Alerta 3: Tarea excede el doble del tiempo estándar ────────────────────
// Tarea in_progress con time_log abierto > 2x standard_minutes.
async function alertTaskOvertime(workDate) {
  const res = await query(
    `SELECT ti.instance_id, ti.title, ti.standard_minutes,
            e.employee_id, e.full_name,
            ROUND(EXTRACT(EPOCH FROM (NOW() - ttl.start_ts)) / 60) AS elapsed_minutes,
            sup.employee_id AS supervisor_id, sup.full_name AS supervisor_name,
            sup.phone_e164 AS supervisor_phone, sup.telegram_id AS supervisor_telegram_id,
            sup.role AS supervisor_role
     FROM task_instances ti
     JOIN employees e ON e.employee_id = ti.employee_id
     JOIN task_time_log ttl ON ttl.instance_id = ti.instance_id AND ttl.employee_id = ti.employee_id AND ttl.end_ts IS NULL
     LEFT JOIN employees sup ON sup.employee_id = e.supervisor_id
     WHERE ti.work_date = $1
       AND ti.status = 'in_progress'
       AND ti.standard_minutes > 0
       -- Tiempo transcurrido > factor * standard_minutes
       AND EXTRACT(EPOCH FROM (NOW() - ttl.start_ts)) / 60 > (ti.standard_minutes * $2)
       -- No se ha notificado ya por esta tarea específica hoy
       AND NOT EXISTS (
         SELECT 1 FROM supervisor_escalations esc
         WHERE esc.employee_id = ti.employee_id
           AND esc.work_date = $1
           AND esc.reason = 'TASK_OVERTIME'
           AND esc.inbound_text LIKE '%' || ti.title || '%'
       )`,
    [workDate, OVERTIME_FACTOR]
  );

  for (const row of res.rows) {
    const notifMsg = `⏰ *Tarea excede tiempo estimado*\nEmpleado: ${row.full_name}\nTarea: ${row.title}\nTiempo real: ${row.elapsed_minutes} min (estimado: ${row.standard_minutes} min, límite: ${Math.round(row.standard_minutes * OVERTIME_FACTOR)} min)`;

    const formLink = await insertEscalation(row.employee_id, row.supervisor_id, workDate, 'TASK_OVERTIME', notifMsg, row.supervisor_role);

    if (row.supervisor_telegram_id || row.supervisor_phone) {
      await outboxService.queueMessage(row.supervisor_telegram_id || row.supervisor_phone, notifMsg + formLink);
      logger.info('Alert TASK_OVERTIME sent', { employee: row.full_name, task: row.title, elapsed: row.elapsed_minutes });
    }

    // Also notify all general supervisors (sin link de formulario)
    await outboxService.notifyGeneralSupervisors(notifMsg);
  }
}

// ─── Alerta 4: Tareas no cerradas al fin de turno ────────────────────────────
// Empleado cuyo turno ya terminó (+ grace) pero dejó tareas in_progress o blocked.
// Da visibilidad al supervisor de trabajo inconcluso y permite seguimiento.
async function alertOpenTasksAtShiftEnd(workDate) {
  const res = await query(
    `SELECT e.employee_id, e.full_name,
            st.start_time AS shift_start_time,
            st.end_time   AS shift_end_time,
            st.shift_code, st.shift_name,
            -- Lista agregada de tareas abiertas (in_progress + blocked)
            (SELECT json_agg(json_build_object(
                      'title',            ti.title,
                      'status',           ti.status,
                      'started_at',       ti.started_at,
                      'standard_minutes', ti.standard_minutes,
                      'progress_percent', ti.progress_percent,
                      'blocked_reason',   ti.blocked_reason
                    ) ORDER BY ti.started_at NULLS LAST, ti.display_order)
             FROM task_instances ti
             WHERE ti.employee_id = e.employee_id
               AND ti.work_date = $1
               AND ti.status IN ('in_progress', 'blocked')) AS open_tasks,
            sup.employee_id AS supervisor_id, sup.full_name AS supervisor_name,
            sup.phone_e164 AS supervisor_phone, sup.telegram_id AS supervisor_telegram_id,
            sup.role AS supervisor_role
     FROM shift_assignments sa
     JOIN shift_templates    st ON st.shift_id = sa.shift_id AND st.is_active = true
     JOIN employees e ON e.employee_id = sa.employee_id
     LEFT JOIN employees sup ON sup.employee_id = e.supervisor_id
     WHERE sa.work_date = $1
       AND e.is_active = true
       -- El turno YA terminó hace al menos $2 minutos (grace post-turno).
       -- Soporte para turnos nocturnos (end_time <= start_time → end es al día siguiente).
       AND NOW() > (
             CASE
               WHEN st.end_time <= st.start_time THEN
                 (CURRENT_DATE + INTERVAL '1 day' + st.end_time
                    + ($2 || ' minutes')::interval)
               ELSE
                 (CURRENT_DATE + st.end_time
                    + ($2 || ' minutes')::interval)
             END
           )
       -- Tiene al menos una tarea abierta (in_progress o blocked) en su jornada.
       -- planned NO se considera aquí — esas nunca se iniciaron, es otro problema
       -- (cubierto por NO_TASK_1H durante el turno).
       AND EXISTS (
         SELECT 1 FROM task_instances ti
         WHERE ti.employee_id = e.employee_id
           AND ti.work_date = $1
           AND ti.status IN ('in_progress', 'blocked')
       )
       -- Dedup: no re-alertar en el mismo día por el mismo empleado
       AND NOT EXISTS (
         SELECT 1 FROM supervisor_escalations esc
         WHERE esc.employee_id = e.employee_id
           AND esc.work_date = $1
           AND esc.reason = 'OPEN_TASKS_SHIFT_END'
       )`,
    [workDate, OPEN_TASKS_END_GRACE_MINUTES]
  );

  for (const emp of res.rows) {
    const endHHMM = String(emp.shift_end_time).substring(0, 5);
    const openTasks = Array.isArray(emp.open_tasks) ? emp.open_tasks : [];
    const inProgress = openTasks.filter(t => t.status === 'in_progress');
    const blocked    = openTasks.filter(t => t.status === 'blocked');

    // Construir listado de tareas para el mensaje
    let taskList = '';
    if (inProgress.length > 0) {
      taskList += `\n\n🔄 *En progreso (${inProgress.length}):*`;
      for (const t of inProgress) {
        const startStr = t.started_at
          ? new Date(t.started_at).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', hour12: false })
          : '--';
        const pct = t.progress_percent != null ? ` · ${t.progress_percent}%` : '';
        const std = t.standard_minutes ? ` · std ${t.standard_minutes}m` : '';
        taskList += `\n  • ${t.title} (inicio ${startStr}${std}${pct})`;
      }
    }
    if (blocked.length > 0) {
      taskList += `\n\n🚫 *Bloqueadas (${blocked.length}):*`;
      for (const t of blocked) {
        const reason = t.blocked_reason ? ` — ${t.blocked_reason}` : '';
        taskList += `\n  • ${t.title}${reason}`;
      }
    }

    const notifMsg = `📋 *Tareas no cerradas al fin de turno*\nEmpleado: ${emp.full_name}\nTurno: ${emp.shift_code || emp.shift_name} (fin: ${endHHMM})\nDejó ${openTasks.length} tarea${openTasks.length > 1 ? 's' : ''} sin cerrar.${taskList}`;

    const formLink = await insertEscalation(emp.employee_id, emp.supervisor_id, workDate, 'OPEN_TASKS_SHIFT_END', notifMsg, emp.supervisor_role);

    if (emp.supervisor_telegram_id || emp.supervisor_phone) {
      await outboxService.queueMessage(emp.supervisor_telegram_id || emp.supervisor_phone, notifMsg + formLink);
      logger.info('Alert OPEN_TASKS_SHIFT_END sent', {
        employee: emp.full_name,
        shift: emp.shift_code,
        inProgress: inProgress.length,
        blocked: blocked.length,
      });
    }

    // También notificar a supervisores generales (sin link de formulario)
    await outboxService.notifyGeneralSupervisors(notifMsg);
  }
}

// ─── Helper: Insertar escalación (con soporte formulario supervisor_auditor) ─
async function insertEscalation(employeeId, supervisorId, workDate, reason, message, supervisorRole) {
  try {
    const requiresForm = supervisorRole === 'supervisor_auditor';
    const escRes = await query(
      `INSERT INTO supervisor_escalations (employee_id, supervisor_id, work_date, reason, inbound_text, requires_form)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING escalation_id`,
      [employeeId, supervisorId || null, workDate, reason, message, requiresForm]
    );

    // Si requiere formulario, generar token y devolver link para anexar al mensaje
    if (requiresForm && supervisorId) {
      const escalationId = escRes.rows[0].escalation_id;
      const token = await taskService.generateEscalationToken(escalationId, supervisorId);
      const MOBILE_BASE_URL = (process.env.MOBILE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
      return `\n\n📋 *Completa el seguimiento:*\n${MOBILE_BASE_URL}/m/escalation/${token}`;
    }
    return '';
  } catch (err) {
    logger.warn('insertEscalation failed', { employeeId, reason, err: err.message });
    return '';
  }
}

module.exports = { startSupervisorAlertsCron };
