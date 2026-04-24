require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const logger = require('./utils/logger');
const { testConnection } = require('./config/database');
const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');
const mobileRoutes = require('./routes/mobile');
const externalRoutes = require('./routes/external');
const { startAutoCheckinCron } = require('./cron/autoCheckin');
const { startOutboxWorker } = require('./cron/outboxWorker');
const { startAutoCheckoutCron } = require('./cron/autoCheckout');
const { startSupervisorAlertsCron } = require('./cron/supervisorAlerts');


const app = express();
const PORT = parseInt(process.env.PORT || '3000');

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(path.resolve(uploadDir)));

// Logs dir
const logsDir = path.resolve('./logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// Request logging
app.use((req, res, next) => {
  if (req.path !== '/webhook/health') {
    logger.info(`${req.method} ${req.path}`, {
      ip: req.ip,
      contentLength: req.get('content-length'),
    });
  }
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// Mobile task page (token-based, no login)
app.get('/m/task/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile', 'task.html'));
});
app.get('/m/assign/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile', 'assign-task.html'));
});
app.get('/m/escalation/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mobile', 'escalation.html'));
});
app.use('/api/m', mobileRoutes);

app.use('/webhook', webhookRoutes);
app.use('/api/external', externalRoutes);  // ← antes de /api para evitar colisión
app.use('/api', apiRoutes);

// Root
app.get('/', (req, res) => {
  res.json({
    service: 'TALINDA OpenClaw Backend',
    version: '1.0.0',
    endpoints: {
      webhook: 'POST /webhook/openclaw',
      upload: 'POST /webhook/upload',
      health: 'GET /webhook/health',
      api: {
        employees: 'GET /api/employees',
        employeeTasks: 'GET /api/employees/:id/tasks?date=YYYY-MM-DD',
        tasksToday: 'GET /api/tasks/today',
        shiftsToday: 'GET /api/shifts/today',
        dashboard: 'GET /api/dashboard',
        messages: 'GET /api/employees/:id/messages',
        nlpStats: 'GET /api/nlp/stats',
        outbox: 'GET /api/outbox',
      },
      external: {
        _auth:        'X-API-Key: <EXTERNAL_API_KEY env>',
        createTask:   'POST /api/external/tasks',
        findByRef:    'GET  /api/external/tasks?external_source=<s>&external_ref=<r>',
        getTask:      'GET  /api/external/tasks/:task_id',
        updateTask:   'PATCH /api/external/tasks/:task_id',
        cancelTask:   'DELETE /api/external/tasks/:task_id',
        setStatus:    'PATCH /api/external/tasks/:task_id/status',
        addNote:      'POST /api/external/tasks/:task_id/notes',
        attach:       'POST /api/external/tasks/:task_id/attachments',
      },
    },
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function start() {
  logger.info('Starting TALINDA OpenClaw Backend...');

  // ── Env var sanity checks (warnings no bloquean el arranque) ──────────────
  // MOBILE_BASE_URL es obligatorio para que los links de Telegram
  // (/m/assign, /m/task, /m/escalation) apunten al dominio público.
  const mbu = process.env.MOBILE_BASE_URL;
  if (!mbu || mbu === 'http://localhost:3000' || mbu === 'https://' || !/^https?:\/\/.+/.test(mbu)) {
    logger.warn(
      'MOBILE_BASE_URL no está correctamente configurado — los links que se envían por Telegram' +
      ' (/m/assign, /m/task, /m/escalation) apuntarán al fallback http://localhost:3000 y NO serán accesibles al empleado.' +
      ' Seteá en el .env algo como: MOBILE_BASE_URL=https://gestion.talinda.es'
    );
  }
  // EXTERNAL_API_KEY sin valor → endpoint /api/external/tasks queda deshabilitado (503)
  if (!process.env.EXTERNAL_API_KEY) {
    logger.info('EXTERNAL_API_KEY no configurado — endpoint /api/external/tasks responderá 503. (OK si no usás integraciones externas.)');
  }

  // Test database connection
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('Cannot connect to database. Check your .env configuration.');
    process.exit(1);
  }

  // ── TZ alignment check (warning si las 3 capas no coinciden) ─────────────
  // El bot necesita que Node, APP_TIMEZONE y el timezone de Postgres
  // coincidan con la zona operativa. Un mismatch típico:
  //   - APP_TIMEZONE=Europe/Madrid (heredado de Talinda)
  //   - pero Postgres timezone = America/Guatemala
  // → `getTodayDate()` devuelve un día distinto al `CURRENT_DATE` del SQL,
  //   y las tareas "de hoy" quedan en work_date distinto al que busca el bot.
  // Ocurrió en Hetzner abr-2026. Ver CLAUDE.md gotcha #11.
  try {
    const appTz = process.env.APP_TIMEZONE || 'America/Guatemala';
    const processTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { query } = require('./config/database');
    const r = await query(`SELECT current_setting('TimeZone') AS pg_tz, CURRENT_DATE::text AS pg_today`);
    const pgTz = r.rows[0].pg_tz;
    const pgToday = r.rows[0].pg_today;
    const nodeToday = new Date().toLocaleDateString('sv-SE', { timeZone: appTz });

    logger.info('TZ check', {
      appTimezone: appTz,
      processTimezone: processTz,
      postgresTimezone: pgTz,
      nodeToday,
      pgToday,
    });

    if (nodeToday !== pgToday) {
      logger.warn(
        `TZ MISMATCH: getTodayDate() dice ${nodeToday} (APP_TIMEZONE=${appTz}) ` +
        `pero Postgres dice ${pgToday} (timezone=${pgTz}). ` +
        `Las tareas creadas podrían quedar en fechas distintas a las que el bot busca. ` +
        `Fix: alinear APP_TIMEZONE del .env con el timezone de Postgres ` +
        `(ALTER SYSTEM SET timezone='${appTz}'; SELECT pg_reload_conf();). ` +
        `Ver CLAUDE.md gotcha #11.`
      );
    }
    if (pgTz !== appTz && pgTz !== 'UTC') {
      // Cualquier mismatch que no sea UTC → advertir (UTC→appTz es recuperable con el helper)
      logger.warn(
        `TZ advisory: Postgres timezone=${pgTz} != APP_TIMEZONE=${appTz}. ` +
        `Recomendado alinear para evitar confusiones futuras.`
      );
    }
  } catch (err) {
    logger.warn('TZ check failed', { err: err.message });
  }

  // Start cron jobs
  startAutoCheckinCron();
  startAutoCheckoutCron();
  startSupervisorAlertsCron();
  startOutboxWorker();

  // Start server
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on http://0.0.0.0:${PORT}`);
    logger.info(`Webhook URL: http://localhost:${PORT}/webhook/openclaw`);
    logger.info(`Dashboard API: http://localhost:${PORT}/api/dashboard`);
  });
}

start().catch((err) => {
  logger.error('Failed to start server', { err: err.message });
  process.exit(1);
});

module.exports = app;
