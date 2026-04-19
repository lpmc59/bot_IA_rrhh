const { query } = require('../config/database');
const logger = require('../utils/logger');
const { getTodayDate } = require('../utils/dateHelper');

// ─── Shift lookup ─────────────────────────────────────────────────────────────
// All shift queries LEFT JOIN shift_calendar to respect holidays / non-workdays.
// Logic: if shift_calendar has NO entry  → normal workday (include)
//        if shift_calendar.is_workday = true  → explicitly a workday (include)
//        if shift_calendar.is_workday = false → holiday / non-workday (exclude)

/**
 * Convert "HH:MM:SS" string to total minutes since midnight.
 */
function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Minutes from timeA to timeB (forward, same day).
 * Always returns a positive value assuming timeB is AFTER timeA on the clock.
 * For overnight wraps (timeB < timeA) returns the forward distance through midnight.
 */
function minutesUntil(fromTime, toTime) {
  const from = timeToMinutes(fromTime);
  const to = timeToMinutes(toTime);
  return to >= from ? to - from : (1440 - from) + to;
}

/**
 * Find the correct shift for an employee right now.
 *
 * Priority:
 *   1. Shift that covers current time (employee is mid-shift)
 *   2. Next upcoming shift within early-arrival tolerance (default 30 min)
 *   3. null — employee is too early (or between shifts)
 *
 * The returned object includes:
 *   - All shift_template columns + assign_id, role_note
 *   - _early: true if the employee is within the tolerance window but shift hasn't started
 *   - _minutesUntilStart: minutes remaining until shift starts (only when _early)
 *
 * Overnight shift handling:
 *   A shift with end < start (e.g. 22:00-06:00) assigned to work_date D means
 *   it STARTS at 22:00 on day D.  At 05:45 on day D, that shift has NOT started
 *   yet (it starts at 22:00 today), so we must NOT match currentTime <= end.
 *   We only match currentTime >= start for the "start" portion on day D.
 */
async function getCurrentShiftForEmployee(employeeId, workDate) {
  const now = new Date();
  const currentTime = now.toTimeString().substring(0, 8); // "HH:MM:SS"
  const currentMin = timeToMinutes(currentTime);

  const toleranceMinutes = parseInt(process.env.SHIFT_EARLY_TOLERANCE_MINUTES || '30', 10);

  const res = await query(
    `SELECT st.*, sa.assign_id, sa.role_note
     FROM shift_assignments sa
     JOIN shift_templates st ON st.shift_id = sa.shift_id
     LEFT JOIN shift_calendar sc ON sc.shift_id = sa.shift_id AND sc.work_date = sa.work_date
     WHERE sa.employee_id = $1
       AND sa.work_date = $2
       AND st.is_active = true
       AND (sc.cal_id IS NULL OR sc.is_workday = true)
     ORDER BY st.start_time ASC`,
    [employeeId, workDate]
  );

  if (res.rows.length === 0) return null;

  // ─── 1. Find a shift whose time range covers the current time ──────
  for (const shift of res.rows) {
    const startMin = timeToMinutes(shift.start_time);
    const endMin = timeToMinutes(shift.end_time);
    const isOvernight = endMin < startMin;

    if (isOvernight) {
      // Overnight shift assigned to THIS work_date starts today at start_time.
      // Match only the START portion (currentTime >= start).
      // The END portion (00:00–end) belongs to the previous day's assignment.
      if (currentMin >= startMin) return shift;
    } else {
      if (currentMin >= startMin && currentMin <= endMin) return shift;
    }
  }

  // ─── 2. Find the next upcoming shift within the early-arrival tolerance ──
  let bestCandidate = null;
  let bestDistance = Infinity;

  for (const shift of res.rows) {
    const startMin = timeToMinutes(shift.start_time);
    // How many minutes until this shift starts?
    const distance = startMin > currentMin
      ? startMin - currentMin            // later today
      : (1440 - currentMin) + startMin;  // wraps past midnight

    // Only consider shifts that haven't started yet and are "soon"
    if (distance > 0 && distance <= toleranceMinutes && distance < bestDistance) {
      bestCandidate = shift;
      bestDistance = distance;
    }
  }

  if (bestCandidate) {
    // Mark as early arrival so handleCheckIn can mention it
    bestCandidate._early = true;
    bestCandidate._minutesUntilStart = bestDistance;
    return bestCandidate;
  }

  // ─── 3. No active shift, not within tolerance → find next shift today ──
  //     Return it but mark as too early so caller can decide what to do.
  let nextShift = null;
  let nextDistance = Infinity;

  for (const shift of res.rows) {
    const startMin = timeToMinutes(shift.start_time);
    const distance = startMin > currentMin
      ? startMin - currentMin
      : (1440 - currentMin) + startMin;

    if (distance > 0 && distance < nextDistance) {
      nextShift = shift;
      nextDistance = distance;
    }
  }

  if (nextShift) {
    nextShift._tooEarly = true;
    nextShift._minutesUntilStart = nextDistance;
    return nextShift;
  }

  // All shifts already ended today — return the last one (most recent)
  return res.rows[res.rows.length - 1];
}

async function getTodayShiftAssignments(workDate) {
  const res = await query(
    `SELECT sa.*, st.shift_code, st.start_time, st.end_time,
            e.employee_id, e.full_name, e.phone_e164
     FROM shift_assignments sa
     JOIN shift_templates st ON st.shift_id = sa.shift_id
     JOIN employees e ON e.employee_id = sa.employee_id
     LEFT JOIN shift_calendar sc ON sc.shift_id = sa.shift_id AND sc.work_date = sa.work_date
     WHERE sa.work_date = $1
       AND st.is_active = true
       AND e.is_active = true
       AND (sc.cal_id IS NULL OR sc.is_workday = true)
     ORDER BY st.start_time ASC`,
    [workDate]
  );
  return res.rows;
}

async function getShiftTaskTemplates(shiftId) {
  const res = await query(
    `SELECT tt.*, stt.standard_minutes, stt.frequency
     FROM shift_task_templates stt
     JOIN task_templates tt ON tt.template_id = stt.template_id
     WHERE stt.shift_id = $1
       AND stt.is_active = true
       AND tt.is_active = true
     ORDER BY tt.default_priority ASC`,
    [shiftId]
  );
  return res.rows;
}

async function getUpcomingShiftStarts(minutesAhead) {
  const now = new Date();
  const workDate = getTodayDate();
  const currentTime = now.toTimeString().substring(0, 8);

  // Calculate time N minutes ahead
  const future = new Date(now.getTime() + minutesAhead * 60000);
  const futureTime = future.toTimeString().substring(0, 8);

  const res = await query(
    `SELECT DISTINCT sa.employee_id, sa.shift_id, st.start_time, st.shift_code,
            e.full_name, e.phone_e164
     FROM shift_assignments sa
     JOIN shift_templates st ON st.shift_id = sa.shift_id
     JOIN employees e ON e.employee_id = sa.employee_id
     LEFT JOIN shift_calendar sc ON sc.shift_id = sa.shift_id AND sc.work_date = sa.work_date
     WHERE sa.work_date = $1
       AND st.start_time BETWEEN $2 AND $3
       AND st.is_active = true
       AND e.is_active = true
       AND (sc.cal_id IS NULL OR sc.is_workday = true)`,
    [workDate, currentTime, futureTime]
  );
  return res.rows;
}

// ─── Calendar management ──────────────────────────────────────────────────────

/**
 * Check if a specific shift is a workday on a given date.
 * Returns true if: no calendar entry (default) OR is_workday = true.
 */
async function isWorkday(shiftId, workDate) {
  const res = await query(
    `SELECT is_workday FROM shift_calendar
     WHERE shift_id = $1 AND work_date = $2`,
    [shiftId, workDate]
  );
  if (res.rows.length === 0) return true; // No entry = normal workday
  return res.rows[0].is_workday;
}

/**
 * Mark a date as holiday (non-workday) for a specific shift.
 * Use shiftId = null to mark ALL shifts for that date.
 */
async function markHoliday(workDate, shiftId = null) {
  if (shiftId) {
    await query(
      `INSERT INTO shift_calendar (work_date, shift_id, is_workday)
       VALUES ($1, $2, false)
       ON CONFLICT (work_date, shift_id)
         DO UPDATE SET is_workday = false`,
      [workDate, shiftId]
    );
    logger.info('Holiday marked', { workDate, shiftId });
  } else {
    // Mark ALL active shifts as holiday for this date
    await query(
      `INSERT INTO shift_calendar (work_date, shift_id, is_workday)
       SELECT $1, shift_id, false
       FROM shift_templates
       WHERE is_active = true
       ON CONFLICT (work_date, shift_id)
         DO UPDATE SET is_workday = false`,
      [workDate]
    );
    logger.info('Holiday marked for all shifts', { workDate });
  }
}

/**
 * Remove a holiday (restore as workday) for a specific date.
 * Deletes the calendar entry so default behavior (workday) applies.
 */
async function removeHoliday(workDate, shiftId = null) {
  if (shiftId) {
    await query(
      `DELETE FROM shift_calendar WHERE work_date = $1 AND shift_id = $2`,
      [workDate, shiftId]
    );
  } else {
    await query(
      `DELETE FROM shift_calendar WHERE work_date = $1`,
      [workDate]
    );
  }
  logger.info('Holiday removed', { workDate, shiftId: shiftId || 'all' });
}

/**
 * Get all holidays/non-workdays in a date range.
 */
async function getHolidays(fromDate, toDate) {
  const res = await query(
    `SELECT sc.work_date, sc.shift_id, st.shift_code, st.shift_name
     FROM shift_calendar sc
     JOIN shift_templates st ON st.shift_id = sc.shift_id
     WHERE sc.work_date BETWEEN $1 AND $2
       AND sc.is_workday = false
     ORDER BY sc.work_date, st.shift_code`,
    [fromDate, toDate]
  );
  return res.rows;
}

module.exports = {
  getCurrentShiftForEmployee,
  getTodayShiftAssignments,
  getShiftTaskTemplates,
  getUpcomingShiftStarts,
  isWorkday,
  markHoliday,
  removeHoliday,
  getHolidays,
};
