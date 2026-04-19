const { query } = require('../config/database');
const logger = require('../utils/logger');

async function findByPhone(phoneE164) {
  const res = await query(
    `SELECT e.*, d.dept_name, d.dept_type, t.team_name
     FROM employees e
     LEFT JOIN departments d ON d.department_id = e.department_id
     LEFT JOIN teams t ON t.team_id = e.team_id
     WHERE e.phone_e164 = $1 AND e.is_active = true`,
    [phoneE164]
  );
  return res.rows[0] || null;
}

async function findByOpenclawUserId(openclawUserId) {
  const res = await query(
    `SELECT e.*, d.dept_name, d.dept_type, t.team_name
     FROM employees e
     LEFT JOIN departments d ON d.department_id = e.department_id
     LEFT JOIN teams t ON t.team_id = e.team_id
     WHERE e.openclaw_user_id = $1 AND e.is_active = true`,
    [openclawUserId]
  );
  return res.rows[0] || null;
}

async function findByTelegramId(telegramId) {
  const res = await query(
    `SELECT e.*, d.dept_name, d.dept_type, t.team_name
     FROM employees e
     LEFT JOIN departments d ON d.department_id = e.department_id
     LEFT JOIN teams t ON t.team_id = e.team_id
     WHERE e.telegram_id = $1 AND e.is_active = true`,
    [String(telegramId)]
  );
  return res.rows[0] || null;
}

async function linkTelegram(employeeId, telegramId) {
  await query(
    `UPDATE employees SET telegram_id = $1 WHERE employee_id = $2`,
    [String(telegramId), employeeId]
  );
}

async function findById(employeeId) {
  const res = await query(
    `SELECT e.*, d.dept_name, d.dept_type, t.team_name
     FROM employees e
     LEFT JOIN departments d ON d.department_id = e.department_id
     LEFT JOIN teams t ON t.team_id = e.team_id
     WHERE e.employee_id = $1`,
    [employeeId]
  );
  return res.rows[0] || null;
}

async function updateLastSeen(employeeId) {
  await query(
    `UPDATE employees SET last_seen_at = NOW() WHERE employee_id = $1`,
    [employeeId]
  );
}

async function linkOpenclawUser(employeeId, openclawUserId) {
  await query(
    `UPDATE employees SET openclaw_user_id = $1 WHERE employee_id = $2`,
    [openclawUserId, employeeId]
  );
}

async function getSupervisor(employeeId) {
  const res = await query(
    `SELECT s.*
     FROM employees e
     JOIN employees s ON s.employee_id = e.supervisor_id
     WHERE e.employee_id = $1`,
    [employeeId]
  );
  return res.rows[0] || null;
}

async function getActiveEmployeesForShift(shiftId, workDate) {
  const res = await query(
    `SELECT e.*, sa.assign_id
     FROM shift_assignments sa
     JOIN employees e ON e.employee_id = sa.employee_id
     WHERE sa.shift_id = $1
       AND sa.work_date = $2
       AND e.is_active = true`,
    [shiftId, workDate]
  );
  return res.rows;
}

module.exports = {
  findByPhone,
  findByOpenclawUserId,
  findByTelegramId,
  findById,
  updateLastSeen,
  linkOpenclawUser,
  linkTelegram,
  getSupervisor,
  getActiveEmployeesForShift,
};
