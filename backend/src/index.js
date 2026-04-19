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
    },
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function start() {
  logger.info('Starting TALINDA OpenClaw Backend...');

  // Test database connection
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('Cannot connect to database. Check your .env configuration.');
    process.exit(1);
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
