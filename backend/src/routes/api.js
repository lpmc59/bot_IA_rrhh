const { Router } = require('express');
const { query } = require('../config/database');
const { getTodayDate } = require('../utils/dateHelper');
const taskService = require('../services/taskService');
const employeeService = require('../services/employeeService');
const shiftService = require('../services/shiftService');
const logger = require('../utils/logger');

const router = Router();

// ─── Employees ───────────────────────────────────────────────────────────────

router.get('/employees', async (req, res) => {
  try {
    const result = await query(
      `SELECT e.employee_id, e.full_name, e.phone_e164, e.email, e.role,
              e.is_active, e.last_seen_at, e.openclaw_user_id,
              d.dept_name, t.team_name
       FROM employees e
       LEFT JOIN departments d ON d.department_id = e.department_id
       LEFT JOIN teams t ON t.team_id = e.team_id
       WHERE e.is_active = true
       ORDER BY e.full_name`
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    logger.error('GET /employees failed', { err: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/employees/:id', async (req, res) => {
  try {
    const emp = await employeeService.findById(req.params.id);
    if (!emp) return res.status(404).json({ ok: false, error: 'Employee not found' });
    res.json({ ok: true, data: emp });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Tasks ───────────────────────────────────────────────────────────────────

router.get('/employees/:id/tasks', async (req, res) => {
  try {
    const workDate = req.query.date || getTodayDate();
    const tasks = await taskService.getTodayTasksForEmployee(req.params.id, workDate);
    res.json({ ok: true, data: tasks, workDate });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/tasks/today', async (req, res) => {
  try {
    const workDate = req.query.date || getTodayDate();
    const result = await query(
      `SELECT ti.*, e.full_name, st.shift_code
       FROM task_instances ti
       JOIN employees e ON e.employee_id = ti.employee_id
       LEFT JOIN shift_templates st ON st.shift_id = ti.shift_id
       WHERE ti.work_date = $1
       ORDER BY e.full_name, ti.status, ti.created_at`,
      [workDate]
    );
    res.json({ ok: true, data: result.rows, workDate });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Shifts ──────────────────────────────────────────────────────────────────

router.get('/shifts/today', async (req, res) => {
  try {
    const workDate = req.query.date || getTodayDate();
    const assignments = await shiftService.getTodayShiftAssignments(workDate);
    res.json({ ok: true, data: assignments, workDate });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Dashboard stats ─────────────────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {
  try {
    const workDate = req.query.date || getTodayDate();

    const [tasksRes, checkinsRes, messagesRes] = await Promise.all([
      query(
        `SELECT status, COUNT(*)::int AS count
         FROM task_instances
         WHERE work_date = $1
         GROUP BY status`,
        [workDate]
      ),
      query(
        `SELECT COUNT(DISTINCT employee_id)::int AS checked_in
         FROM checkins
         WHERE work_date = $1 AND checkin_type = 'start_day' AND status = 'answered'`,
        [workDate]
      ),
      query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE direction = 'in')::int AS inbound,
                COUNT(*) FILTER (WHERE direction = 'out')::int AS outbound
         FROM chat_messages
         WHERE received_ts::date = $1::date`,
        [workDate]
      ),
    ]);

    const taskStats = {};
    for (const row of tasksRes.rows) taskStats[row.status] = row.count;

    res.json({
      ok: true,
      workDate,
      tasks: {
        planned: taskStats.planned || 0,
        in_progress: taskStats.in_progress || 0,
        blocked: taskStats.blocked || 0,
        done: taskStats.done || 0,
        canceled: taskStats.canceled || 0,
        total: Object.values(taskStats).reduce((a, b) => a + b, 0),
      },
      checkedIn: checkinsRes.rows[0].checked_in,
      messages: messagesRes.rows[0],
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Chat history ────────────────────────────────────────────────────────────

router.get('/employees/:id/messages', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const result = await query(
      `SELECT * FROM chat_messages
       WHERE employee_id = $1
       ORDER BY received_ts DESC
       LIMIT $2`,
      [req.params.id, limit]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── NLP analytics ───────────────────────────────────────────────────────────

router.get('/nlp/stats', async (req, res) => {
  try {
    const workDate = req.query.date || getTodayDate();
    const result = await query(
      `SELECT intent, COUNT(*)::int AS count,
              AVG(confidence)::numeric(4,3) AS avg_confidence,
              COUNT(*) FILTER (WHERE (model_info->>'usedClaude')::boolean = true)::int AS claude_calls,
              SUM((model_info->>'inputTokens')::int) AS total_input_tokens,
              SUM((model_info->>'outputTokens')::int) AS total_output_tokens
       FROM nlp_message_extractions
       WHERE work_date = $1
       GROUP BY intent
       ORDER BY count DESC`,
      [workDate]
    );
    res.json({ ok: true, data: result.rows, workDate });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Outbox status ───────────────────────────────────────────────────────────

router.get('/outbox', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const result = await query(
      `SELECT * FROM outbox_messages ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
