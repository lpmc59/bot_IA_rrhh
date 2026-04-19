const { query } = require('../config/database');
const logger = require('../utils/logger');

async function registerCheckIn(employeeId, workDate, shift, locationInfo = null) {
  try {
    const loc = locationInfo || {};
    await query(
      `INSERT INTO checkins (
         employee_id, checkin_type, scheduled_ts, sent_ts, answered_ts, status,
         question_text, answer_text, work_date,
         location_required, location_shared, location_lat, location_lng,
         location_accuracy_m, distance_m, location_valid, location_status,
         location_resolved_from
       )
       VALUES ($1, 'start_day', NOW(), NOW(), NOW(), 'answered',
               'Reporte de inicio de jornada', 'Empleado se reportó', $2,
               $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (employee_id, work_date, checkin_type)
         DO UPDATE SET
           answered_ts = NOW(),
           status = 'answered',
           answer_text = 'Empleado se reportó',
           location_required = EXCLUDED.location_required,
           location_shared = EXCLUDED.location_shared,
           location_lat = EXCLUDED.location_lat,
           location_lng = EXCLUDED.location_lng,
           location_accuracy_m = EXCLUDED.location_accuracy_m,
           distance_m = EXCLUDED.distance_m,
           location_valid = EXCLUDED.location_valid,
           location_status = EXCLUDED.location_status,
           location_resolved_from = EXCLUDED.location_resolved_from`,
      [
        employeeId, workDate,
        loc.required ?? false,
        loc.shared ?? null,
        loc.lat ?? null,
        loc.lng ?? null,
        loc.accuracy_m ?? null,
        loc.distance_m ?? null,
        loc.valid ?? null,
        loc.status ?? 'not_required',
        loc.resolved_from ?? null,
      ]
    );
    logger.info('Check-in registered', { employeeId, workDate, locationStatus: loc.status });
    return true;
  } catch (err) {
    logger.error('registerCheckIn failed', { err: err.message });
    return false;
  }
}

async function hasCheckedInToday(employeeId, workDate) {
  const res = await query(
    `SELECT 1 FROM checkins
     WHERE employee_id = $1
       AND work_date = $2
       AND checkin_type = 'start_day'
       AND status = 'answered'
     LIMIT 1`,
    [employeeId, workDate]
  );
  return res.rows.length > 0;
}

async function getEmployeesNotCheckedIn(workDate) {
  const res = await query(
    `SELECT DISTINCT sa.employee_id, sa.shift_id, st.start_time, st.shift_code,
            e.full_name, e.phone_e164, e.telegram_id
     FROM shift_assignments sa
     JOIN shift_templates st ON st.shift_id = sa.shift_id
     JOIN employees e ON e.employee_id = sa.employee_id
     LEFT JOIN shift_calendar sc ON sc.shift_id = sa.shift_id AND sc.work_date = sa.work_date
     WHERE sa.work_date = $1
       AND st.is_active = true
       AND e.is_active = true
       AND (e.phone_e164 IS NOT NULL OR e.telegram_id IS NOT NULL)
       AND (sc.cal_id IS NULL OR sc.is_workday = true)
       AND NOT EXISTS (
         SELECT 1 FROM checkins c
         WHERE c.employee_id = sa.employee_id
           AND c.work_date = $1
           AND c.checkin_type = 'start_day'
           AND c.status = 'answered'
       )`,
    [workDate]
  );
  return res.rows;
}

async function createScheduledCheckin(employeeId, workDate, checkinType, question) {
  try {
    await query(
      `INSERT INTO checkins (employee_id, checkin_type, scheduled_ts, status, question_text, work_date)
       VALUES ($1, $2, NOW(), 'sent', $3, $4)
       ON CONFLICT (employee_id, work_date, checkin_type) DO NOTHING`,
      [employeeId, checkinType, question, workDate]
    );
  } catch (err) {
    logger.warn('createScheduledCheckin failed', { err: err.message });
  }
}

async function registerCheckOut(employeeId, workDate, source = 'manual', locationInfo = null) {
  // source: 'manual' = empleado dijo "ya me voy"
  //         'auto'   = cron cerró el turno automáticamente tras 20 min sin respuesta
  const answerText = source === 'auto'
    ? 'Cierre automático por sistema'
    : 'Empleado reportó salida';
  const loc = locationInfo || {};
  try {
    await query(
      `INSERT INTO checkins (
         employee_id, checkin_type, scheduled_ts, sent_ts, answered_ts, status,
         question_text, answer_text, work_date,
         location_required, location_shared, location_lat, location_lng,
         location_accuracy_m, distance_m, location_valid, location_status,
         location_resolved_from
       )
       VALUES ($1, 'end_day', NOW(), NOW(), NOW(), 'answered',
               'Reporte de fin de jornada', $3, $2,
               $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (employee_id, work_date, checkin_type)
         DO UPDATE SET
           answered_ts = NOW(),
           status = 'answered',
           answer_text = $3,
           location_required = EXCLUDED.location_required,
           location_shared = EXCLUDED.location_shared,
           location_lat = EXCLUDED.location_lat,
           location_lng = EXCLUDED.location_lng,
           location_accuracy_m = EXCLUDED.location_accuracy_m,
           distance_m = EXCLUDED.distance_m,
           location_valid = EXCLUDED.location_valid,
           location_status = EXCLUDED.location_status,
           location_resolved_from = EXCLUDED.location_resolved_from`,
      [
        employeeId, workDate, answerText,
        loc.required ?? false,
        loc.shared ?? null,
        loc.lat ?? null,
        loc.lng ?? null,
        loc.accuracy_m ?? null,
        loc.distance_m ?? null,
        loc.valid ?? null,
        loc.status ?? 'not_required',
        loc.resolved_from ?? null,
      ]
    );
    logger.info('Check-out registered', { employeeId, workDate, source, locationStatus: loc.status });
    return true;
  } catch (err) {
    logger.error('registerCheckOut failed', { err: err.message });
    return false;
  }
}

async function getAttendanceSummary(employeeId, workDate) {
  const res = await query(
    `SELECT checkin_type, answered_ts, status
     FROM checkins
     WHERE employee_id = $1
       AND work_date = $2
       AND status = 'answered'
     ORDER BY answered_ts`,
    [employeeId, workDate]
  );
  return res.rows;
}

// ─── Reminder tracking ──────────────────────────────────────────────────────

async function hasReminderBeenSent(employeeId, workDate, checkinType) {
  const res = await query(
    `SELECT 1 FROM checkins
     WHERE employee_id = $1
       AND work_date = $2
       AND checkin_type = $3
     LIMIT 1`,
    [employeeId, workDate, checkinType]
  );
  return res.rows.length > 0;
}

async function hasCheckedOutToday(employeeId, workDate) {
  const res = await query(
    `SELECT 1 FROM checkins
     WHERE employee_id = $1
       AND work_date = $2
       AND checkin_type = 'end_day'
       AND status = 'answered'
     LIMIT 1`,
    [employeeId, workDate]
  );
  return res.rows.length > 0;
}

async function getEndDayRecord(employeeId, workDate) {
  const res = await query(
    `SELECT * FROM checkins
     WHERE employee_id = $1
       AND work_date = $2
       AND checkin_type = 'end_day'
     LIMIT 1`,
    [employeeId, workDate]
  );
  return res.rows[0] || null;
}

async function extendCheckoutDeadline(employeeId, workDate) {
  // Reset scheduled_ts to NOW(), which restarts the auto-close countdown
  await query(
    `UPDATE checkins
     SET scheduled_ts = NOW(), question_text = 'Extensión: aún trabajando'
     WHERE employee_id = $1
       AND work_date = $2
       AND checkin_type = 'end_day'
       AND status = 'sent'`,
    [employeeId, workDate]
  );
}

// ─── End-of-shift: employees who checked in but not out ─────────────────────

async function getEmployeesNotCheckedOut(workDate) {
  // Returns employees who checked IN (answered) but have NOT checked OUT (answered).
  // Excludes only 'answered' end_day records, so a 'sent' reminder doesn't hide them.
  // Respects shift_calendar: skips shifts marked as non-workday (holidays).
  const res = await query(
    `SELECT DISTINCT sa.employee_id, sa.shift_id, st.start_time, st.end_time, st.shift_code,
            e.full_name, e.phone_e164, e.telegram_id
     FROM shift_assignments sa
     JOIN shift_templates st ON st.shift_id = sa.shift_id
     JOIN employees e ON e.employee_id = sa.employee_id
     JOIN checkins c_in ON c_in.employee_id = sa.employee_id
       AND c_in.work_date = $1
       AND c_in.checkin_type = 'start_day'
       AND c_in.status = 'answered'
     LEFT JOIN shift_calendar sc ON sc.shift_id = sa.shift_id AND sc.work_date = sa.work_date
     WHERE sa.work_date = $1
       AND st.is_active = true
       AND e.is_active = true
       AND (e.phone_e164 IS NOT NULL OR e.telegram_id IS NOT NULL)
       AND (sc.cal_id IS NULL OR sc.is_workday = true)
       AND NOT EXISTS (
         SELECT 1 FROM checkins c_out
         WHERE c_out.employee_id = sa.employee_id
           AND c_out.work_date = $1
           AND c_out.checkin_type = 'end_day'
           AND c_out.status = 'answered'
       )`,
    [workDate]
  );
  return res.rows;
}

// ─── Manager: Reporte de asistencia del día ────────────────────────────────
async function getTeamAttendanceReport(workDate) {
  const res = await query(
    `SELECT
       e.employee_id,
       e.full_name,
       e.role,
       st.shift_code,
       st.start_time,
       st.end_time,
       c_in.answered_ts AS checkin_time,
       c_out.answered_ts AS checkout_time,
       CASE
         WHEN c_in.status = 'answered' THEN true
         ELSE false
       END AS has_checked_in,
       CASE
         WHEN c_out.status = 'answered' THEN true
         ELSE false
       END AS has_checked_out
     FROM shift_assignments sa
     JOIN shift_templates st ON st.shift_id = sa.shift_id
     JOIN employees e ON e.employee_id = sa.employee_id
     LEFT JOIN shift_calendar sc ON sc.shift_id = sa.shift_id AND sc.work_date = sa.work_date
     LEFT JOIN checkins c_in ON c_in.employee_id = e.employee_id
       AND c_in.work_date = $1 AND c_in.checkin_type = 'start_day'
     LEFT JOIN checkins c_out ON c_out.employee_id = e.employee_id
       AND c_out.work_date = $1 AND c_out.checkin_type = 'end_day'
     WHERE sa.work_date = $1
       AND st.is_active = true
       AND e.is_active = true
       AND (sc.cal_id IS NULL OR sc.is_workday = true)
     ORDER BY st.start_time, e.full_name`,
    [workDate]
  );
  return res.rows;
}

module.exports = {
  registerCheckIn,
  registerCheckOut,
  hasCheckedInToday,
  hasCheckedOutToday,
  getEmployeesNotCheckedIn,
  getEmployeesNotCheckedOut,
  hasReminderBeenSent,
  createScheduledCheckin,
  getEndDayRecord,
  extendCheckoutDeadline,
  getAttendanceSummary,
  getTeamAttendanceReport,
};
