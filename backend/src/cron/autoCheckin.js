const cron = require('node-cron');
const logger = require('../utils/logger');
const { getTodayDate } = require('../utils/dateHelper');
const checkinService = require('../services/checkinService');
const outboxService = require('../services/outboxService');

const DELAY_MINUTES = parseInt(process.env.AUTO_CHECKIN_DELAY_MINUTES || '5');

function startAutoCheckinCron() {
  // Run every 5 minutes to check for employees who haven't reported
  cron.schedule('*/5 * * * *', async () => {
    try {
      await processAutoCheckins();
    } catch (err) {
      logger.error('Auto check-in cron failed', { err: err.message });
    }
  });

  logger.info(`Auto check-in cron started (delay: ${DELAY_MINUTES} min)`);
}

async function processAutoCheckins() {
  const workDate = getTodayDate();
  const now = new Date();

  // Get employees who haven't checked in but their shift started > N minutes ago
  const notCheckedIn = await checkinService.getEmployeesNotCheckedIn(workDate);

  for (const emp of notCheckedIn) {
    const shiftStart = emp.start_time; // HH:MM:SS
    const shiftStartDate = new Date(`${workDate}T${shiftStart}`);
    const minutesSinceStart = (now - shiftStartDate) / 60000;

    // Only send reminder once: between DELAY and DELAY+10 minutes, and only if not already reminded
    if (minutesSinceStart >= DELAY_MINUTES && minutesSinceStart < DELAY_MINUTES + 10) {
      // Check if we already sent a reminder for this employee today
      const alreadySent = await checkinService.hasReminderBeenSent(emp.employee_id, workDate, 'start_day');
      if (alreadySent) continue;

      logger.info('Sending check-in reminder', {
        employee: emp.full_name,
        shiftCode: emp.shift_code,
        minutesSinceStart: Math.round(minutesSinceStart),
      });

      // Record that we sent the reminder (status 'sent', not 'answered')
      await checkinService.createScheduledCheckin(
        emp.employee_id,
        workDate,
        'start_day',
        '¿Ya estás en tus labores?'
      );

      // Send a question — don't auto-register or generate tasks
      const firstName = emp.full_name.split(' ')[0];
      const startHHMM = emp.start_time.substring(0, 5);
      const msg =
        `👋 ¡Hola ${firstName}! Tu turno *${emp.shift_code}* empezó a las ${startHHMM}.\n\n` +
        `¿Ya estás en tus labores?\n\n` +
        `Responde *"me reporto"* para registrar tu llegada y ver tus tareas asignadas.`;

      const target = emp.telegram_id || emp.phone_e164;
      if (target) {
        await outboxService.queueMessage(target, msg);
      }
    }
  }
}

module.exports = { startAutoCheckinCron };
