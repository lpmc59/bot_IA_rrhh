const cron = require('node-cron');
const logger = require('../utils/logger');
const { getTodayDate } = require('../utils/dateHelper');
const checkinService = require('../services/checkinService');
const taskService = require('../services/taskService');
const outboxService = require('../services/outboxService');

const GRACE_MINUTES = parseInt(process.env.AUTO_CHECKOUT_GRACE_MINUTES || '5');
const AUTO_CLOSE_MINUTES = parseInt(process.env.AUTO_CHECKOUT_CLOSE_MINUTES || '20');

function startAutoCheckoutCron() {
  // Run every 5 minutes to check for employees who haven't reported end of shift
  cron.schedule('*/5 * * * *', async () => {
    try {
      await processAutoCheckouts();
    } catch (err) {
      logger.error('Auto check-out cron failed', { err: err.message });
    }
  });

  logger.info(`Auto check-out cron started (grace: ${GRACE_MINUTES} min, auto-close: ${AUTO_CLOSE_MINUTES} min)`);
}

async function processAutoCheckouts() {
  const workDate = getTodayDate();
  const now = new Date();

  // Get employees who checked in but haven't checked out (status 'answered')
  const notCheckedOut = await checkinService.getEmployeesNotCheckedOut(workDate);

  for (const emp of notCheckedOut) {
    const shiftEnd = emp.end_time; // HH:MM:SS
    let shiftEndDate = new Date(`${workDate}T${shiftEnd}`);

    // Handle overnight shifts: if end_time < start_time, shift ends next day
    if (emp.end_time < emp.start_time) {
      shiftEndDate = new Date(shiftEndDate.getTime() + 24 * 60 * 60 * 1000);
    }

    const minutesSinceEnd = (now - shiftEndDate) / 60000;

    // Skip if shift hasn't ended + grace period yet
    if (minutesSinceEnd < GRACE_MINUTES) continue;

    // Check if we already have an end_day record (reminder sent or extension)
    const endDayRecord = await checkinService.getEndDayRecord(emp.employee_id, workDate);

    if (!endDayRecord) {
      // ─── PHASE 1: First reminder ──────────────────────────────────────
      logger.info('Sending check-out reminder', {
        employee: emp.full_name,
        shiftCode: emp.shift_code,
        minutesSinceEnd: Math.round(minutesSinceEnd),
      });

      // Create end_day record with status='sent', scheduled_ts=NOW()
      // scheduled_ts is used as the "deadline reference" — auto-close happens
      // AUTO_CLOSE_MINUTES after this timestamp
      await checkinService.createScheduledCheckin(
        emp.employee_id,
        workDate,
        'end_day',
        '¿Ya terminaste tu turno?'
      );

      // Build task summary for the message
      const tasks = await taskService.getTodayTasksForEmployee(emp.employee_id, workDate);
      const completed = tasks.filter(t => t.status === 'done').length;
      const total = tasks.length;

      const firstName = emp.full_name.split(' ')[0];
      const endHHMM = emp.end_time.substring(0, 5);
      let msg =
        `⏰ ${firstName}, tu turno *${emp.shift_code}* terminó a las ${endHHMM}.\n\n`;

      if (total > 0) {
        msg += `📊 Tareas completadas: *${completed}/${total}*\n\n`;
      }

      msg += `¿Ya terminaste tu jornada?\n\n`;
      msg += `Responde *"ya me voy"* para registrar tu salida, o *"aún no"* si sigues trabajando.`;

      const target1 = emp.telegram_id || emp.phone_e164;
      if (target1) {
        await outboxService.queueMessage(target1, msg);
      }

    } else if (endDayRecord.status === 'sent') {
      // ─── PHASE 2: Check if deadline has passed ─────────────────────────
      // scheduled_ts is the reference time (either original send or last extension)
      const scheduledTs = new Date(endDayRecord.scheduled_ts);
      const minutesSinceScheduled = (now - scheduledTs) / 60000;

      if (minutesSinceScheduled >= AUTO_CLOSE_MINUTES) {
        logger.info('Auto check-out triggered (deadline passed)', {
          employee: emp.full_name,
          shiftCode: emp.shift_code,
          minutesSinceScheduled: Math.round(minutesSinceScheduled),
        });

        // Close open time logs
        await taskService.stopTimeLog(emp.employee_id);

        // Register system checkout (updates status to 'answered', marked as auto)
        await checkinService.registerCheckOut(emp.employee_id, workDate, 'auto');

        // Notify employee
        const firstName = emp.full_name.split(' ')[0];
        const msg =
          `📋 ${firstName}, tu turno fue cerrado automáticamente.\n\n` +
          `Si aún estás trabajando, avisa a tu supervisor.\n` +
          `¡Buen descanso! 🌙`;

        const target2 = emp.telegram_id || emp.phone_e164;
        if (target2) {
          await outboxService.queueMessage(target2, msg);
        }
      }
      // else: deadline hasn't passed yet, do nothing (employee may have extended)
    }
    // If status is 'answered', skip (already checked out manually or by previous auto-close)
  }
}

module.exports = { startAutoCheckoutCron };
