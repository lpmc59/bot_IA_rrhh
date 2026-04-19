const { query, getClient } = require('../config/database');
const logger = require('../utils/logger');
const { getTodayDate } = require('../utils/dateHelper');
const employeeService = require('./employeeService');
const taskService = require('./taskService');
const shiftService = require('./shiftService');
const nlpService = require('./nlpService');
const checkinService = require('./checkinService');
const attachmentService = require('./attachmentService');
const outboxService = require('./outboxService');
const locationService = require('./locationService');

async function getOrCreateSession(employeeId, channel) {
  const res = await query(
    `INSERT INTO chat_sessions (employee_id, channel, state, last_inbound_at)
     VALUES ($1, $2, 'IDLE', NOW())
     ON CONFLICT (employee_id, channel) DO UPDATE
       SET last_inbound_at = NOW(), updated_at = NOW()
     RETURNING *`,
    [employeeId, channel]
  );
  return res.rows[0];
}

async function saveChatMessage(employeeId, channel, direction, text, rawPayload) {
  const res = await query(
    `INSERT INTO chat_messages (employee_id, channel, direction, message_text, raw_payload)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING message_id`,
    [employeeId, channel, direction, text, rawPayload ? JSON.stringify(rawPayload) : null]
  );
  return res.rows[0].message_id;
}

async function updateSessionState(sessionId, state, payload) {
  await query(
    `UPDATE chat_sessions SET state = $1, state_payload = $2 WHERE session_id = $3`,
    [state, JSON.stringify(payload || {}), sessionId]
  );
}

// ─── Time Log Guard: requiere inicio antes de reportar avance ────────────────
// Verifica que el empleado tenga un time log abierto para la tarea específica.
// Si no, bloquea el avance y pregunta si quiere iniciarla.
async function requireTaskStarted(employeeId, instanceId, taskTitle, session) {
  const openLog = await taskService.getOpenTimeLog(employeeId);
  if (openLog && openLog.instance_id === instanceId) {
    return null; // OK, esta tarea tiene un time log abierto
  }
  // No hay time log para esta tarea → preguntar
  await updateSessionState(session.session_id, 'WAITING_START_BEFORE_PROGRESS', {
    instanceId,
    taskTitle,
  });
  const msg = openLog
    ? `⏱️ Estás trabajando en otra tarea. Para reportar avance en "*${taskTitle}*", primero debes iniciarla.\n\n¿Quieres iniciar "*${taskTitle}*" ahora? Responde *sí* o *no*.`
    : `⏱️ No tengo registrado el inicio de "*${taskTitle}*". Para registrar tu avance necesito saber cuándo la iniciaste.\n\n¿Quieres iniciarla ahora? Responde *sí* o *no*.`;
  return { reply: msg };
}

// ─── Fast Completion Guard: validar tareas completadas sospechosamente rápido ─
// Solo aplica a tareas repetitivas con standard_minutes.
// Si el tiempo real es < 50% del estimado, pide confirmación y escala al supervisor.
async function requireNormalCompletion(employeeId, instanceId, taskTitle, session, messageId, extraPayload) {
  // ── Check 1: ¿La tarea fue iniciada? ──
  // Si el status es 'planned', el empleado nunca dijo "empiezo con..."
  const status = await taskService.getInstanceStatus(instanceId);
  if (status === 'planned') {
    await updateSessionState(session.session_id, 'WAITING_START_BEFORE_DONE', {
      instanceId,
      taskTitle,
      messageId,
      ...extraPayload,
    });
    return {
      reply: `⏱️ La tarea "*${taskTitle}*" no ha sido iniciada.\n\n¿La completaste sin reportar el inicio? Responde *sí* para completarla (se notificará a tu supervisor) o *no* para iniciarla primero.`,
    };
  }

  // ── Check 2: ¿Completada demasiado rápido? ──
  const fastCheck = await taskService.checkFastCompletion(instanceId, employeeId);
  if (!fastCheck) return null; // Tiempo normal → proceder
  await updateSessionState(session.session_id, 'WAITING_FAST_DONE_CONFIRM', {
    instanceId,
    taskTitle,
    elapsedMinutes: fastCheck.elapsedMinutes,
    standardMinutes: fastCheck.standardMinutes,
    messageId,
    ...extraPayload,
  });
  return {
    reply: `⚡ Reportas "*${taskTitle}*" completada en *${fastCheck.elapsedMinutes} min*, pero el tiempo estimado es *${fastCheck.standardMinutes} min*.\n\n¿Confirmas que ya terminaste? Responde *sí* o *no*.`,
  };
}

// ─── Completion Reply Helper: mensaje contextualizado post-markTaskDone ───────
// Caso 1: sin tareas en progreso → "¿Vas a iniciar otra? Quedan N pendientes."
// Caso 2: con tareas en progreso → "Aún tienes N en progreso." (no preguntar)
async function buildCompletionReply(taskTitle, employeeId, workDate, shiftId, session) {
  const tasks = await taskService.getTodayTasksForEmployee(employeeId, workDate, shiftId);
  const remaining = tasks.filter(t => t.status !== 'done' && t.status !== 'canceled');
  const inProgress = remaining.filter(t => t.status === 'in_progress');

  let reply = `✅ Tarea "*${taskTitle}*" completada!`;

  if (remaining.length === 0) {
    reply += '\n\n🎉 ¡Terminaste todas tus tareas!';
  } else if (inProgress.length > 0) {
    // Caso 2: tiene tareas en progreso → solo informar, no preguntar
    const pendingCount = remaining.length - inProgress.length;
    reply += `\n\nAún tienes ${inProgress.length} tarea(s) en progreso`;
    if (pendingCount > 0) {
      reply += ` y ${pendingCount} pendiente(s)`;
    }
    reply += '.';
  } else {
    // Caso 1: solo pendientes → preguntar si inicia otra
    reply += `\n\n¿Vas a iniciar otra? Quedan ${remaining.length} pendiente(s).`;
    // Guardar estado para que "sí" muestre la lista de tareas
    if (session) {
      await updateSessionState(session.session_id, 'WAITING_NEXT_TASK_CONFIRM', {
        pendingTasks: remaining.map(t => ({ id: t.instance_id, title: t.title, task_id: t.task_id })),
      });
    }
  }

  return reply;
}

// ─── Manejar texto recibido mientras esperamos ubicacion ──────────────────
// Cualquier texto se interpreta como negativa a compartir → registrar como
// not_shared y completar el check-in/out con escalonamiento al supervisor.
async function handleWaitingLocationText(session, employee, cleaned, workDate, shift) {
  const payload = session.state_payload || {};
  const checkType = payload.checkType;

  // Si el texto esta vacio (no deberia llegar aqui), reiterar instrucciones
  if (!cleaned) {
    return {
      reply: `📍 Estoy esperando tu ubicación. En Telegram: clip 📎 → *Ubicación* → *Compartir mi ubicación actual*.\n\nSi no puedes, responde *no puedo*.`,
      employee,
    };
  }

  const locationInfo = {
    required: true,
    shared: false,
    lat: null,
    lng: null,
    accuracy_m: null,
    distance_m: null,
    valid: false,
    status: 'not_shared',
    resolved_from: null,
  };
  await updateSessionState(session.session_id, 'IDLE', {});

  const currentShift = shift || (payload.shiftId
    ? await shiftService.getCurrentShiftForEmployee(employee.employee_id, workDate)
    : null);

  if (checkType === 'start_day') {
    const reply = await completeCheckIn(employee, workDate, currentShift, locationInfo);
    return { reply, employee };
  }
  if (checkType === 'end_day') {
    const reply = await completeCheckOut(employee, workDate, currentShift, locationInfo);
    return { reply, employee };
  }

  return { reply: '📍 Sesión de ubicación expirada. Por favor reporta tu entrada o salida de nuevo.', employee };
}

// ─── Manejar payload de ubicacion entrante ─────────────────────────────────
// Solo es relevante si la sesion esta en WAITING_LOCATION (esperando ubicacion
// para completar un check-in/out). Si no, solo confirmamos recepcion.
async function handleLocationPayload(session, employee, locationPayload, workDate, shift) {
  const { latitude, longitude, accuracy_m } = locationPayload;

  if (!session || session.state !== 'WAITING_LOCATION') {
    return {
      reply: '📍 Recibí tu ubicación, pero ahora mismo no la necesitaba. Si quieres registrar entrada o salida, escribe *me reporto* o *ya me voy*.',
      employee,
    };
  }

  const payload = session.state_payload || {};
  const checkType = payload.checkType; // 'start_day' | 'end_day'

  // Validar la ubicacion contra la zona autorizada
  const validation = await locationService.validateLocation(employee, latitude, longitude, accuracy_m);

  let locationInfo;
  if (!validation) {
    // No se pudo resolver ubicacion autorizada → registrar como not_required
    logger.warn('Location validation skipped: no authorized location resolved', {
      employeeId: employee.employee_id,
    });
    locationInfo = {
      required: true,
      shared: true,
      lat: latitude,
      lng: longitude,
      accuracy_m,
      distance_m: null,
      valid: null,
      status: 'not_required',
      resolved_from: null,
    };
  } else {
    locationInfo = {
      required: true,
      shared: true,
      lat: latitude,
      lng: longitude,
      accuracy_m,
      distance_m: validation.distance_m,
      valid: validation.valid,
      status: validation.status,
      resolved_from: validation.authorized.source,
      authorized_radius_m: validation.authorized.radius_m,
    };
  }

  // Limpiar estado y completar el check-in/out
  await updateSessionState(session.session_id, 'IDLE', {});

  if (checkType === 'start_day') {
    const reply = await completeCheckIn(employee, workDate, shift, locationInfo);
    return { reply, employee };
  }
  if (checkType === 'end_day') {
    const reply = await completeCheckOut(employee, workDate, shift, locationInfo);
    return { reply, employee };
  }

  return { reply: '📍 Ubicación recibida pero no había una acción esperando.', employee };
}

// ─── Main message processing ─────────────────────────────────────────────────

async function processInboundMessage({ phone, openclawUserId, telegramId, text, channel, rawPayload, isVoiceTranscription, locationPayload }) {
  try {
  const workDate = getTodayDate();

  // 1. Identify employee
  let employee = null;

  // Try Telegram ID first (fastest for Telegram users)
  if (telegramId) {
    employee = await employeeService.findByTelegramId(telegramId);
  }
  if (!employee && openclawUserId) {
    employee = await employeeService.findByOpenclawUserId(openclawUserId);
  }
  if (!employee && phone) {
    employee = await employeeService.findByPhone(phone);
  }

  // Auto-link IDs for faster future lookups
  if (employee) {
    if (openclawUserId && !employee.openclaw_user_id) {
      await employeeService.linkOpenclawUser(employee.employee_id, openclawUserId);
      logger.info('Auto-linked OpenClaw user', { employeeId: employee.employee_id, openclawUserId });
    }
    if (telegramId && !employee.telegram_id) {
      await employeeService.linkTelegram(employee.employee_id, telegramId);
      logger.info('Auto-linked Telegram ID', { employeeId: employee.employee_id, telegramId });
    }
  }

  if (!employee) {
    // ── Telegram auto-registration flow ──
    // If user sends a phone number, try to link their Telegram ID
    if (telegramId && text) {
      const phoneMatch = text.replace(/[\s\-\(\)]/g, '').match(/^\+?\d{7,15}$/);
      if (phoneMatch) {
        let phoneToSearch = phoneMatch[0];
        if (!phoneToSearch.startsWith('+')) phoneToSearch = '+' + phoneToSearch;
        const empByPhone = await employeeService.findByPhone(phoneToSearch);
        if (empByPhone) {
          if (empByPhone.telegram_id && empByPhone.telegram_id !== String(telegramId)) {
            logger.warn('Phone already linked to different Telegram ID', {
              phone: phoneToSearch, existingTelegramId: empByPhone.telegram_id, newTelegramId: telegramId
            });
            return {
              reply: 'Este número ya está vinculado a otra cuenta de Telegram. Contacta a tu supervisor.',
              employee: null,
            };
          }
          await employeeService.linkTelegram(empByPhone.employee_id, telegramId);
          logger.info('Telegram auto-registration successful', {
            employeeId: empByPhone.employee_id, telegramId, phone: phoneToSearch
          });
          return {
            reply: `✅ ¡Registro exitoso! Bienvenido/a ${empByPhone.full_name}. Ya puedes usar el sistema. Escribe "hola" para comenzar.`,
            employee: empByPhone,
          };
        } else {
          return {
            reply: 'No encontré ese número de teléfono en el sistema. Verifica que sea el mismo número registrado por tu supervisor (con código de país, ej: +34612345678).',
            employee: null,
          };
        }
      }
    }

    logger.warn('Unknown employee', { phone, openclawUserId, telegramId });
    return {
      reply: 'No te tenemos registrado en el sistema.\n\nPara registrarte, envía tu número de teléfono con código de país.\nEjemplo: +34612345678',
      employee: null,
    };
  }

  // Update last seen
  await employeeService.updateLastSeen(employee.employee_id);

  // 2. Save inbound message
  const messageId = await saveChatMessage(employee.employee_id, channel || process.env.MESSAGING_CHANNEL || 'telegram', 'in', text, rawPayload);

  // 3. Get or create session
  const session = await getOrCreateSession(employee.employee_id, channel || process.env.MESSAGING_CHANNEL || 'telegram');

  // 4. Get current shift and active task for context
  const shift = await shiftService.getCurrentShiftForEmployee(employee.employee_id, workDate);
  const activeTask = await taskService.getActiveTask(employee.employee_id, workDate);
  const employeeContext = {
    ...employee,
    currentTask: activeTask,
    currentShift: shift,
  };

  // 4.5 ─── Location event: el empleado compartio su ubicacion ──────────────
  // Si llega con locationPayload, debemos resolverlo segun el estado de sesion:
  //  - Si esta WAITING_LOCATION → completar el check-in/out con esa ubicacion
  //  - Si no, solo confirmamos recepcion (no es el momento)
  if (locationPayload) {
    const stateResult = await handleLocationPayload(session, employee, locationPayload, workDate, shift);
    if (stateResult) {
      try {
        await saveChatMessage(employee.employee_id, channel || process.env.MESSAGING_CHANNEL || 'telegram', 'out', stateResult.reply, null);
      } catch (saveErr) {
        logger.error('Failed to save OUT message (location)', { err: saveErr.message });
      }
      return stateResult;
    }
  }

  // 5. Check if we're waiting for a specific response (session state)
  let postCheckoutConfirmed = false;
  if (session.state !== 'IDLE') {
    const stateResult = await handleSessionState(session, employee, text, messageId, workDate, shift);
    if (stateResult) {
      // Si el handler devuelve _reprocessText, significa que el usuario confirmó
      // una acción post-checkout → reinyectar el texto original en el pipeline
      if (stateResult._reprocessText) {
        text = stateResult._reprocessText;
        postCheckoutConfirmed = true; // Saltar el guard porque ya confirmó
        // Continuar al paso 5.5 con el texto original
      } else {
        // Save outbound message from session state handlers
        if (stateResult.reply) {
          try {
            await saveChatMessage(employee.employee_id, channel || process.env.MESSAGING_CHANNEL || 'telegram', 'out', stateResult.reply, null);
          } catch (saveErr) {
            logger.error('Failed to save OUT message (session state)', { err: saveErr.message, employeeId: employee.employee_id });
          }
        }
        return stateResult;
      }
    }
  }

  // 5.1 ─── Post-checkout guard: confirmar antes de acciones de tarea ─────
  // Si el empleado ya registró salida y envía algo que parece acción de tarea,
  // pedir confirmación y notificar al supervisor si confirma.
  if (session.state === 'IDLE' && !postCheckoutConfirmed) {
    const isCheckedOut = await checkinService.hasCheckedOutToday(employee.employee_id, workDate);
    if (isCheckedOut) {
      // Mensajes "seguros" que NO requieren confirmación (consultas, saludos)
      const isSafe = /^(mis\s+tareas|tareas|lista|dashboard|resumen|reporte|ayuda|help|hola|buenos?\s*d[ií]as?|buenas?\s*(tardes?|noches?)|qu[eé]\s+tal|me\s+reporto|ya\s+llegu[eé]|ya\s+me\s+voy|salgo|estoy\s+saliendo)/i.test(text.trim());
      if (!isSafe) {
        await updateSessionState(session.session_id, 'WAITING_POST_CHECKOUT_CONFIRM', {
          originalText: text,
          messageId,
        });
        const reply = `⚠️ Ya registraste tu salida hoy. ¿Seguro que quieres realizar esta acción?\n\nResponde *sí* para confirmar o *no* para cancelar.`;
        await saveChatMessage(employee.employee_id, channel || process.env.MESSAGING_CHANNEL || 'telegram', 'out', reply, null);
        return { reply, employee, nlpResult: null };
      }
    }
  }

  // 5.5 ─── PRE-NLP: Resolución contextual de referencias a tareas ──────
  // Si el usuario dice "la 1", "empiezo con la 2", "limpieza entrada", etc.
  // lo resolvemos ANTES del NLP genérico para evitar crear tareas basura.
  const taskRefResult = await tryResolveTaskReference(text, employee, workDate, messageId, shift, session);
  if (taskRefResult) {
    const refNlp = { intent: taskRefResult.intent, confidence: 1.0, entities: {}, usedClaude: false };
    logger.info('Pre-NLP: Task reference resolved', { intent: taskRefResult.intent, instanceId: taskRefResult.instanceId });
    try {
      await nlpService.saveExtraction(messageId, employee.employee_id, workDate, refNlp, taskRefResult.instanceId);
    } catch (saveErr) {
      logger.warn('saveExtraction failed (non-fatal)', { err: saveErr.message });
    }
    try {
      await saveChatMessage(employee.employee_id, channel || process.env.MESSAGING_CHANNEL || 'telegram', 'out', taskRefResult.reply, null);
    } catch (saveErr) {
      logger.error('Failed to save OUT message (pre-NLP)', { err: saveErr.message, employeeId: employee.employee_id });
    }
    return { reply: taskRefResult.reply, employee, nlpResult: refNlp };
  }

  // 6. NLP analysis (solo si pre-NLP no resolvió)
  const todayTasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);
  const nlpResult = await nlpService.analyze(text, { ...employeeContext, todayTasks });
  nlpResult.originalText = text; // Preserve original text for number/name references
  logger.info('NLP result', { intent: nlpResult.intent, confidence: nlpResult.confidence, usedClaude: nlpResult.usedClaude });

  // 6b. Si Claude falló por timeout/sobrecarga, dar mensaje amigable sin procesar UNKNOWN
  if (nlpResult.isTransient && nlpResult.intent === 'UNKNOWN') {
    const fallback = 'El servicio está momentáneamente ocupado. Intenta de nuevo en unos segundos, o escribe "mis tareas" para ver tu lista.';
    await saveChatMessage(employee.employee_id, channel || process.env.MESSAGING_CHANNEL || 'telegram', 'out', fallback, null);
    return { reply: fallback, employee, nlpResult };
  }

  // 7. Route by intent
  let reply = '';
  let instanceId = null;

  switch (nlpResult.intent) {
    case 'GREETING':
      reply = await handleGreeting(employee, workDate, shift);
      break;

    case 'CHECK_IN':
      reply = await handleCheckIn(employee, workDate, shift, messageId, session);
      break;

    case 'CHECK_OUT':
      reply = await handleCheckOut(employee, workDate, shift, session);
      break;

    case 'STILL_WORKING':
      reply = await handleStillWorking(employee, workDate, shift);
      break;

    case 'TASK_LIST_REQUEST':
      reply = await handleTaskListRequest(employee, workDate, shift);
      break;

    case 'TASK_DONE':
      ({ reply, instanceId } = await handleTaskDone(employee, workDate, activeTask, messageId, nlpResult, session, shift));
      break;

    case 'TASK_PROGRESS':
      ({ reply, instanceId } = await handleTaskProgress(employee, workDate, activeTask, messageId, nlpResult, session, shift));
      break;

    case 'TASK_BLOCKED':
      ({ reply, instanceId } = await handleTaskBlocked(employee, workDate, activeTask, messageId, nlpResult, session));
      break;

    case 'TASK_CREATE':
      ({ reply, instanceId } = await handleTaskCreate(employee, workDate, shift, messageId, nlpResult, session));
      break;

    case 'TASK_START':
      ({ reply, instanceId } = await handleTaskStart(employee, workDate, messageId, nlpResult, shift, session));
      break;

    case 'ASSIGN_TASK': {
      const isMgr = ['manager', 'admin', 'general_supervisor', 'supervisor_auditor'].includes(employee.role);
      if (!isMgr) {
        reply = 'Esa función es solo para supervisores.';
      } else {
        reply = await handleAssignTask(employee);
      }
      break;
    }

    case 'MANAGER_DASHBOARD':
    case 'MANAGER_ATTENDANCE':
    case 'MANAGER_TASKS':
    case 'MANAGER_REPORT':
    case 'MANAGER_SHIFTS': {
      const isManager = ['manager', 'admin', 'general_supervisor', 'supervisor_auditor'].includes(employee.role);
      if (!isManager) {
        reply = 'Esa función es solo para supervisores. Si necesitas información, contacta a tu supervisor.';
      } else if (nlpResult.intent === 'MANAGER_SHIFTS') {
        reply = await handleManagerShifts(employee, workDate, session);
      } else if (nlpResult.intent === 'MANAGER_DASHBOARD') {
        reply = await handleManagerDashboard(employee, workDate);
      } else if (nlpResult.intent === 'MANAGER_ATTENDANCE') {
        reply = await handleManagerAttendance(employee, workDate);
      } else if (nlpResult.intent === 'MANAGER_REPORT') {
        reply = await handleManagerReport(employee, workDate);
      } else {
        reply = await handleManagerTasks(employee, workDate);
      }
      break;
    }

    case 'VAGUE_MESSAGE':
      reply = await handleVagueMessage(employee, activeTask);
      break;

    default:
      reply = await handleUnknown(employee, text, activeTask);
      break;
  }

  // 8. Save NLP extraction
  try {
    await nlpService.saveExtraction(messageId, employee.employee_id, workDate, nlpResult, instanceId);
  } catch (saveErr) {
    logger.warn('saveExtraction failed (non-fatal)', { err: saveErr.message });
  }

  // 9. Save outbound message
  try {
    await saveChatMessage(employee.employee_id, channel || process.env.MESSAGING_CHANNEL || 'telegram', 'out', reply, null);
  } catch (saveErr) {
    logger.error('Failed to save OUT message (intent handler)', { err: saveErr.message, employeeId: employee.employee_id });
  }

  return { reply, employee, nlpResult };

  } catch (err) {
    // Catch-all: log the error but NEVER return 500 to OpenClaw.
    // A 500 causes "Sistema temporalmente no disponible" for the employee.
    logger.error('processInboundMessage failed', {
      phone, text, err: err.message, stack: err.stack,
    });
    const fallbackReply = 'Tuve un problema procesando tu mensaje. Intenta de nuevo o escribe "mis tareas" para ver tu lista.';
    return { reply: fallbackReply, employee: null, nlpResult: null };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Extract task number reference from text: "el 1", "la tarea 1", "tarea 1", "la primera", "numero 3"
// Uses the FULL task list (same order as "mis tareas") for index matching
function findTaskByNumberRef(text, allTasks, pendingTasks) {
  if (!text || !allTasks || allTasks.length === 0) return null;

  // Match "el 1", "la 1", "con 1", "con la 1", "tarea 1", "la tarea 1", "numero 1", "#1"
  const numMatch = text.match(/(?:el|la|con(?:\s+(?:la|el))?|tarea|la\s+tarea|n[uú]mero|#)\s*(\d+)/i);
  if (numMatch) {
    const idx = parseInt(numMatch[1]) - 1; // 0-based
    // Index into the FULL task list (same order user sees with "mis tareas")
    if (idx >= 0 && idx < allTasks.length) {
      return allTasks[idx];
    }
  }

  // Fallback: número suelto al final del texto, no seguido de %
  // Cubre: "empiezo 1", "inicio 3", "termino 2"
  if (!numMatch) {
    const bareEnd = text.match(/(\d+)\s*$/);
    if (bareEnd && !/\d+\s*(%|por\s*ciento)/i.test(text)) {
      const idx = parseInt(bareEnd[1]) - 1;
      if (idx >= 0 && idx < allTasks.length) {
        return allTasks[idx];
      }
    }
  }

  // Match ordinals: "la primera", "la segunda", "la tercera"
  const ordinals = { primera: 0, segundo: 1, segunda: 1, tercera: 2, tercero: 2, cuarta: 3, cuarto: 3, quinta: 4, quinto: 4 };
  for (const [word, idx] of Object.entries(ordinals)) {
    if (text.toLowerCase().includes(word) && idx < allTasks.length) {
      return allTasks[idx];
    }
  }

  return null;
}

// Extract progress percentage from natural Spanish text (used inside WAITING_TASK_PICK)
function extractProgressFromText(text) {
  const t = text.toLowerCase();
  // Explicit percentage: "50%", "al 50%", "50 por ciento"
  const pctMatch = t.match(/(\d{1,3})\s*(?:%|por\s*ciento|porciento)/);
  if (pctMatch) return Math.min(parseInt(pctMatch[1]), 100);
  // "a la mitad" / "la mitad" / "a medias" = 50%
  if (/(?:a\s+)?la\s+mitad|a\s+medias/i.test(t)) return 50;
  // "casi termino" / "casi lista/o" / "ya casi" / "falta poco" = 85%
  if (/casi\s+(?:termin|list[oa]|acab)|ya\s+casi|ya\s+mero|falta\s+poco|me\s+falta\s+poco/i.test(t)) return 85;
  // "apenas empecé" / "recién empiezo" = 10%
  if (/apenas|reci[eé]n\s+emp/i.test(t)) return 10;
  return null;
}

// Extract time estimate in minutes from Spanish text
// "30 minutos", "45 min", "1 hora", "una hora", "media hora", "hora y media", "como 20 min"
function extractTimeEstimate(text) {
  const t = text.toLowerCase();
  // "hora y media" = 90 min
  if (/hora\s+y\s+media/i.test(t)) return 90;
  // "media hora" = 30 min
  if (/media\s+hora/i.test(t)) return 30;
  // "una hora" = 60 min
  if (/una\s+hora/i.test(t)) return 60;
  // Explicit minutes: "30 minutos", "45 min", "como 20 minutos"
  const minMatch = t.match(/(\d+)\s*(?:minutos?|min\b)/);
  if (minMatch) return Math.max(1, parseInt(minMatch[1]));
  // Explicit hours: "2 horas", "3 horas"
  const hourMatch = t.match(/(\d+)\s*horas?/);
  if (hourMatch) return parseInt(hourMatch[1]) * 60;
  return null;
}

// ─── Supervisor escalation helper ────────────────────────────────────────────
// Inserts into supervisor_escalations AND queues WhatsApp notification.
// Returns { notified: true/false, reason: string }

async function escalateToSupervisor(employee, workDate, reason, messageText, eventId) {
  try {
    const supervisor = await employeeService.getSupervisor(employee.employee_id);

    if (!supervisor) {
      logger.warn('No supervisor found for escalation', {
        employeeId: employee.employee_id, reason,
      });
      return { notified: false, reason: 'sin supervisor asignado' };
    }

    // Determine if this escalation requires a form (supervisor_auditor role)
    const requiresForm = supervisor.role === 'supervisor_auditor';

    // Insert into supervisor_escalations table
    const escRes = await query(
      `INSERT INTO supervisor_escalations (employee_id, supervisor_id, work_date, reason, inbound_text, event_id, requires_form)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING escalation_id`,
      [employee.employee_id, supervisor.employee_id, workDate, reason, messageText, eventId || null, requiresForm]
    );
    const escalationId = escRes.rows[0].escalation_id;

    // Build notification message — append form link for supervisor_auditor
    let finalMessage = messageText;
    if (requiresForm) {
      const token = await taskService.generateEscalationToken(escalationId, supervisor.employee_id);
      const MOBILE_BASE_URL = (process.env.MOBILE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
      const formLink = `${MOBILE_BASE_URL}/m/escalation/${token}`;
      finalMessage += `\n\n📋 *Completa el seguimiento:*\n${formLink}`;
    }

    // Queue notification to direct supervisor (prefer telegram_id over phone)
    const supervisorTarget = supervisor.telegram_id || supervisor.phone_e164;
    if (supervisorTarget) {
      await outboxService.queueMessage(supervisorTarget, finalMessage);
      logger.info('Supervisor notified', {
        supervisorId: supervisor.employee_id, target: supervisorTarget, reason, requiresForm,
      });
    } else {
      logger.warn('Supervisor has no contact info for notification', {
        supervisorId: supervisor.employee_id, reason,
      });
    }

    // Also notify all general supervisors (message without form link — form is only for the assigned supervisor)
    await outboxService.notifyGeneralSupervisors(messageText);

    return { notified: !!supervisorTarget, reason: supervisorTarget ? null : 'supervisor sin contacto registrado' };
  } catch (err) {
    logger.error('escalateToSupervisor failed', { err: err.message, reason });
    return { notified: false, reason: 'error interno' };
  }
}

// ─── Notify supervisor when a blocked task is unblocked ──────────────────────
async function notifyBlockerResolved(employee, workDate, taskName) {
  try {
    const notifMsg = `✅ *Bloqueo resuelto*\nEmpleado: ${employee.full_name}\nTarea: ${taskName}\nEl empleado retomó la tarea.`;
    await escalateToSupervisor(employee, workDate, 'BLOCKER_RESOLVED', notifMsg, null);
  } catch (err) {
    logger.warn('Could not notify blocker resolution', { err: err.message });
  }
}

// ─── Append checklist/resources link if task requires it ────────────────────
async function appendChecklistLink(instanceId, employeeId, baseReply) {
  try {
    const result = await taskService.postStartEnrichment(instanceId, employeeId);
    if (result && result.link) {
      let extra = '\n\n';
      if (result.hasChecklist && result.hasResources) {
        extra += '📋 Esta tarea tiene *checklist* y *recursos requeridos*.';
      } else if (result.hasChecklist) {
        extra += '📋 Esta tarea tiene un *checklist* de pasos a seguir.';
      } else {
        extra += '🔧 Esta tarea tiene *recursos requeridos*.';
      }
      extra += `\n👉 Abre la guía aquí: ${result.link}`;
      return baseReply + extra;
    }
  } catch (err) {
    logger.warn('appendChecklistLink failed (non-fatal)', { instanceId, err: err.message });
  }
  return baseReply;
}

// ─── Compound action: "terminé la 4 y voy con la 5" → DONE + START ──────────
// Soporta todas las combinaciones: número+número, nombre+número, número+nombre, nombre+nombre
// Ejemplos:
//   "terminé la 4 y voy con la 5"                           (num + num)
//   "terminé limpieza terrazas y empiezo la 5"               (nombre + num)
//   "terminé la 4 y voy con limpieza entrada"                (num + nombre)
//   "terminé limpieza terrazas y empiezo baños planta alta"  (nombre + nombre)
//   "terminé limpieza terrazas me dirijo a la número 5"      (nombre + num, sin "y")
//   "terminé y voy con la 5"                                 (activa + num)
//   "terminé y voy con limpieza entrada"                     (activa + nombre)

async function tryCompoundDoneAndStart(text, tasks, employee, workDate, messageId, session) {
  // 1. Verificar que empieza con un verbo DONE
  const donePrefix = /^(?:ya\s+)?(?:termin[eéoa]|acab[eéo]|finalic[eé]|listo|completad[oa]|hecho)/i;
  if (!donePrefix.test(text)) return null;

  // 2. Buscar el punto de corte: donde empieza un verbo START
  const startVerbRe = /[,;.]?\s*(?:y\s+)?(?:voy|empiezo|empec[eé]|inicio|inici[eéó]|arranco|arranqu[eé]|comienzo|comenc[eé]|me\s+(?:pongo|dirijo)|sigo|paso)\s+(?:con\s+|a\s+)?/i;
  const splitMatch = text.match(startVerbRe);
  if (!splitMatch) return null;

  const splitIdx = text.indexOf(splitMatch[0]);
  const donePart = text.substring(0, splitIdx).trim();
  const startPart = text.substring(splitIdx + splitMatch[0].length).trim();

  // 3. Resolver la tarea DONE (número → nombre → tarea activa)
  let doneTask = findTaskByNumberRef(donePart, tasks, tasks);
  if (!doneTask) doneTask = findTaskByFuzzyName(donePart, tasks);
  if (!doneTask) {
    // Sin referencia explícita en la parte DONE → usar la tarea activa
    doneTask = await taskService.getActiveTask(employee.employee_id, workDate);
  }
  if (!doneTask) return null;

  // 4. Resolver la tarea START (número → nombre)
  let startTask = findTaskByNumberRef(startPart, tasks, tasks);
  if (!startTask) startTask = findTaskByFuzzyName(startPart, tasks);
  if (!startTask) return null;

  // 5. No hacer DONE+START sobre la misma tarea
  if (doneTask.instance_id === startTask.instance_id) return null;

  logger.info('Compound DONE+START resolved', {
    donePart, startPart,
    doneTask: doneTask.title, startTask: startTask.title,
  });

  return await executeCompoundDoneStart(doneTask, startTask, employee, messageId, session);
}

async function executeCompoundDoneStart(doneTask, startTask, employee, messageId, session) {
  // 1. Complete the done task (con verificación de rapidez)
  if (doneTask.status !== 'done') {
    const blocked = await requireNormalCompletion(employee.employee_id, doneTask.instance_id, doneTask.title, session, messageId, {
      nextStartInstanceId: startTask.instance_id,
      nextStartTitle: startTask.title,
    });
    if (blocked) return blocked;
    await taskService.markTaskDone(doneTask.instance_id, employee.employee_id, messageId, null);
  }

  // 2. Start the next task
  const wasBlocked2 = startTask.status === 'blocked';
  if (startTask.status === 'done') {
    await taskService.restartTask(startTask.instance_id, employee.employee_id);
  } else if (startTask.status === 'planned' || startTask.status === 'blocked') {
    await taskService.startTask(startTask.instance_id, employee.employee_id);
  }
  if (wasBlocked2) {
    await notifyBlockerResolved(employee, workDate, startTask.title);
  }

  const reply = await appendChecklistLink(startTask.instance_id, employee.employee_id,
    `✅ Tarea "*${doneTask.title}*" completada!\n🔄 Iniciaste "*${startTask.title}*". Avísame cuando avances o termines.`);

  logger.info('Compound DONE+START executed', {
    doneTask: doneTask.title, startTask: startTask.title,
    employeeId: employee.employee_id,
  });

  return {
    reply,
    employee,
    instanceId: startTask.instance_id,
    intent: 'TASK_DONE_AND_START',
  };
}

// ─── Compound: general multi-action in one message ──────────────────────────
// "la 5 al 50% y la 8 al 20%", "terminé la 4 y la 8 al 20%", etc.
// Finds ALL task+action pairs in the text and executes them together.

async function tryCompoundMultiAction(text, tasks, employee, workDate, messageId, session) {
  const actions = [];
  const seenIds = new Set();

  function addAction(idx, action, percent) {
    if (idx < 0 || idx >= tasks.length) return;
    const task = tasks[idx];
    if (seenIds.has(task.instance_id)) return;
    seenIds.add(task.instance_id);
    actions.push({ task, action, percent: percent != null ? percent : null });
  }

  // ── Find all task+action pairs ──────────────────────────────────────────

  // PROGRESS postfix: "la 5 al 50%", "tarea 8 en 20%", "la 3 a 80 por ciento"
  for (const m of text.matchAll(/(?:la|el|tarea|#)\s*(\d+)\s+(?:al?\s+|en\s+)(\d{1,3})\s*(?:%|por\s*ciento)/gi)) {
    addAction(parseInt(m[1]) - 1, 'PROGRESS', Math.min(parseInt(m[2]), 100));
  }
  // PROGRESS prefix: "avancé 10% de la 5", "avance 20% en la 6"
  for (const m of text.matchAll(/(\d{1,3})\s*(?:%|por\s*ciento)\s+(?:de|en)\s+(?:la|el|tarea|#)\s*(\d+)/gi)) {
    addAction(parseInt(m[2]) - 1, 'PROGRESS', Math.min(parseInt(m[1]), 100));
  }

  // DONE: "terminé la 4", "acabé la 3" (presente y pasado)
  for (const m of text.matchAll(/(?:termin[eéo]|acab[eéo]|finalic[eé])\s+(?:con\s+)?(?:la|el|tarea|#)\s*(\d+)/gi)) {
    addAction(parseInt(m[1]) - 1, 'DONE');
  }
  // DONE postfix: "la 5 lista", "la 2 completada"
  for (const m of text.matchAll(/(?:la|el|tarea|#)\s*(\d+)\s+(?:list[oa]|completad[oa]|hech[oa]|terminad[oa])/gi)) {
    addAction(parseInt(m[1]) - 1, 'DONE');
  }

  // START: "empiezo la 5", "empecé la 4", "inició la 3" (presente, pasado, 3ra persona)
  for (const m of text.matchAll(/(?:empiezo|empec[eé]|inicio|inici[eéó]|arranco|arranqu[eé]|comienzo|comenc[eé]|voy|sigo|me\s+pongo)\s+(?:con\s+|a\s+)?(?:la|el|tarea|#)\s*(\d+)/gi)) {
    addAction(parseInt(m[1]) - 1, 'START');
  }

  // VERBAL PROGRESS: "la 5 a la mitad" → 50%, "la 3 casi lista" → 85%
  for (const m of text.matchAll(/(?:la|el|tarea|#)\s*(\d+)\s+(?:a\s+la\s+mitad|a\s+medias)/gi)) {
    addAction(parseInt(m[1]) - 1, 'PROGRESS', 50);
  }
  for (const m of text.matchAll(/(?:la|el|tarea|#)\s*(\d+)\s+(?:casi\s+(?:list|termin|acab)|ya\s+(?:casi|mero)|falta\s+poco)/gi)) {
    addAction(parseInt(m[1]) - 1, 'PROGRESS', 85);
  }

  // ── Herencia de acción: "empecé la 4 y la 5" → la 5 hereda START ──
  // Busca "y la N" / ", la N" que no fueron capturados por los regexes anteriores
  if (actions.length >= 1) {
    const lastAction = actions[actions.length - 1];
    for (const m of text.matchAll(/[,y]\s+(?:la|el)\s*(\d+)/gi)) {
      addAction(parseInt(m[1]) - 1, lastAction.action, lastAction.percent);
    }
  }

  // ── Bare multi-reference: "la 4 y la 5", "si, la 4 y la 5" → default START ──
  // Cuando no hay verbo explícito pero sí 2+ referencias a tareas, asumir START
  if (actions.length === 0) {
    const bareRefs = [...text.matchAll(/(?:la|el|tarea|#)\s*(\d+)/gi)];
    if (bareRefs.length >= 2) {
      for (const m of bareRefs) {
        addAction(parseInt(m[1]) - 1, 'START');
      }
    }
  }

  // Need at least 2 distinct task actions for compound
  if (actions.length < 2) return null;

  // ── Execute all actions and combine replies ─────────────────────────────
  const replies = [];
  let lastInstanceId = null;

  for (const { task, action, percent } of actions) {
    if (action === 'DONE') {
      if (task.status !== 'done') {
        const blocked = await requireNormalCompletion(employee.employee_id, task.instance_id, task.title, session, messageId);
        if (blocked) return blocked;
        await taskService.markTaskDone(task.instance_id, employee.employee_id, messageId, null);
      }
      replies.push(`✅ "*${task.title}*" completada!`);
      lastInstanceId = task.instance_id;
    } else if (action === 'PROGRESS') {
      // Verificar que la tarea tenga time log abierto antes de actualizar avance
      const blocked = await requireTaskStarted(employee.employee_id, task.instance_id, task.title, session);
      if (blocked) return blocked;
      await taskService.updateTaskProgress(task.instance_id, percent, employee.employee_id, messageId, null);
      const emoji = percent >= 100 ? '✅' : percent >= 75 ? '💪' : percent >= 50 ? '👍' : '📊';
      replies.push(`${emoji} "*${task.title}*": ${percent}%`);
      lastInstanceId = task.instance_id;
    } else if (action === 'START') {
      const wasBl = task.status === 'blocked';
      if (task.status === 'done') {
        await taskService.restartTask(task.instance_id, employee.employee_id);
      } else if (task.status === 'planned' || task.status === 'blocked') {
        await taskService.startTask(task.instance_id, employee.employee_id);
      }
      if (wasBl) await notifyBlockerResolved(employee, workDate, task.title);
      const startReply = await appendChecklistLink(task.instance_id, employee.employee_id,
        `🔄 Iniciaste "*${task.title}*"`);
      replies.push(startReply);
      lastInstanceId = task.instance_id;
    }
  }

  logger.info('Compound multi-action executed', {
    count: actions.length,
    summary: actions.map(a => `${a.action}(#${tasks.indexOf(a.task) + 1}${a.percent != null ? ':' + a.percent + '%' : ''})`).join(', '),
    employeeId: employee.employee_id,
  });

  return {
    reply: replies.join('\n'),
    employee,
    instanceId: lastInstanceId,
    intent: 'COMPOUND_MULTI_ACTION',
  };
}

// ─── Pre-NLP: Task Reference Resolution ─────────────────────────────────────
// CLAVE: Cuando el sistema muestra una lista numerada, el usuario naturalmente
// responde con referencias como "la 1", "empiezo con la 2", "limpieza entrada".
// Este resolutor intercepta esas referencias ANTES del NLP genérico,
// evitando que se clasifiquen como "nueva tarea" por error.

// Normalizar acentos/diacríticos para comparación fuzzy
function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const STOP_WORDS = new Set([
  'de', 'del', 'la', 'el', 'las', 'los', 'un', 'una', 'y', 'a', 'en',
  'con', 'que', 'por', 'para', 'es', 'al', 'lo', 'se', 'no', 'si', 'mi',
  'su', 'muy', 'mas', 'esta', 'este', 'eso', 'esa', 'como', 'pero',
]);
// Palabras genéricas que aparecen en muchos títulos de tareas (ubicaciones, descriptivas)
// Se necesitan más matches si solo coinciden palabras genéricas
const GENERIC_TASK_WORDS = new Set([
  'tarea', 'tareas', 'trabajo', 'actividad',
  'area', 'zona', 'piso', 'planta', 'nivel', 'salon', 'cocina', 'bano', 'banos',
  'restaurante', 'restaurantes', 'entrada', 'bodega', 'oficina', 'almacen',
  'general', 'principal', 'segundo', 'primera', 'segundo', 'tercer', 'cuarto',
  'limpieza', 'revision', 'mantenimiento', 'verificacion', 'chequeo',
  'reporte', 'inventario', 'recorrido', 'inspeccion', 'diario', 'diaria',
  'mesas', 'sillas', 'pisos', 'paredes', 'equipo', 'equipos', 'material',
  'materiales', 'producto', 'productos', 'personal', 'servicio',
]);
const ACTION_WORDS = new Set([
  'empiezo', 'empece', 'inicio', 'inicie', 'comienzo', 'comence',
  'arranco', 'arranque', 'voy', 'hacer', 'hago', 'termino', 'termine',
  'listo', 'completado', 'hecho', 'acabe', 'bloqueo', 'bloqueado',
  'avance', 'progreso', 'llevo', 'dije', 'refiero', 'tarea', 'nueva',
  'iniciar', 'empezar', 'comenzar', 'estoy', 'iniciando', 'era', 'digo',
  'quiero', 'necesito', 'pongo', 'meto', 'sigo', 'continuo',
  'dirijo', 'dirigo', 'paso', 'favor', 'terminada', 'terminado',
]);

// ─── Fuzzy name matching helper (reutilizable) ──────────────────────────────
// Busca la tarea cuyo título mejor coincide con las palabras del texto.
// Retorna la tarea con mejor score, o null si no hay match suficiente.
function findTaskByFuzzyName(text, tasks) {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  const contentWords = words.filter(w => !ACTION_WORDS.has(w));
  if (contentWords.length < 1) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const task of tasks) {
    const titleWords = task.title.toLowerCase().split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    if (titleWords.length === 0) continue;

    let matchCount = 0;
    for (const cw of contentWords) {
      const cwNorm = stripAccents(cw);
      for (const tw of titleWords) {
        const twNorm = stripAccents(tw);
        if (twNorm.includes(cwNorm) || cwNorm.includes(twNorm)) { matchCount++; break; }
        if (cwNorm.length >= 5 && twNorm.length >= 5 &&
            cwNorm.substring(0, 5) === twNorm.substring(0, 5)) { matchCount++; break; }
      }
    }

    if ((matchCount >= 2 || (titleWords.length <= 2 && matchCount >= 1)) && matchCount > bestScore) {
      bestScore = matchCount;
      bestMatch = task;
    }
  }

  return bestMatch;
}

async function tryResolveTaskReference(text, employee, workDate, messageId, shift, session) {
  // Skip task reference resolution if text matches a known NLP intent pattern
  // (e.g., "mis tareas", "asignar trabajo", "check in") to avoid false fuzzy matches
  const NLP_PRIORITY_PATTERNS = [
    /(qu[eé]\s+tengo|mis\s+tareas|qu[eé]\s+hago|qu[eé]\s+me\s+toca|tareas\s+del\s+d[ií]a|plan\s+del\s+d[ií]a|ver\s+tareas|lista\s+de\s+tareas|pendientes)/i,
    /asignar?\s+(?:una?\s+)?tareas?/i,
    /asignar\s+(?:trabajo|actividad)/i,
    /check\s*[-_]?\s*in/i,
    /check\s*[-_]?\s*out/i,
    /productividad/i,
    /dashboard/i,
    /asistencia/i,
  ];
  for (const p of NLP_PRIORITY_PATTERNS) {
    if (p.test(text.trim())) return null;
  }

  const tasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);
  if (tasks.length === 0) return null;

  const cleaned = nlpService.normalizeSpanishNumbers(text.trim());
  const cleanedLower = cleaned.toLowerCase();

  // ─── Compound: "terminé la 4 y voy con la 5" → DONE + START ────────
  const compoundResult = await tryCompoundDoneAndStart(cleanedLower, tasks, employee, workDate, messageId, session);
  if (compoundResult) return compoundResult;

  // ─── Multi-action: "la 5 al 50% y la 8 al 20%" → multiple updates ──
  const multiResult = await tryCompoundMultiAction(cleanedLower, tasks, employee, workDate, messageId, session);
  if (multiResult) return multiResult;

  // ─── Paso 1: Identificar a qué tarea se refiere el usuario ──────────
  let targetTask = null;
  let matchMethod = null;

  // 1a. Referencia numérica: "la 1", "tarea 2", "#3", "el 1", "primera"
  targetTask = findTaskByNumberRef(cleaned, tasks, tasks);
  if (targetTask) matchMethod = 'number';

  // 1b-pre. Si el mensaje indica CREACIÓN de tarea nueva, no hacer fuzzy match
  //         "nueva tarea", "inicié una nueva", "tarea nueva de...", "nueva actividad"
  if (!targetTask) {
    const CREATION_PATTERN = /\b(?:nueva\s+(?:tarea|actividad)|(?:tarea|actividad)\s+nueva|crear?\s+(?:una?\s+)?tarea|agregar?\s+(?:una?\s+)?tarea|registrar?\s+(?:una?\s+)?tarea)\b/i;
    if (CREATION_PATTERN.test(cleanedLower)) {
      return null; // dejar que NLP clasifique como TASK_CREATE / NEW_TASK
    }
  }

  // 1b. Fuzzy name: "limpieza entrada" ≈ "Limpieza Entrada Principal Planta Baja"
  if (!targetTask) {
    const msgWords = cleanedLower.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
    // Quitar palabras de acción para comparar solo contenido
    const contentWords = msgWords.filter(w => !ACTION_WORDS.has(w));

    if (contentWords.length >= 1) {
      let bestMatch = null;
      let bestScore = 0;
      let bestSpecificCount = 0;

      for (const task of tasks) {
        const titleWords = task.title.toLowerCase().split(/\s+/)
          .filter(w => w.length > 2 && !STOP_WORDS.has(w));
        if (titleWords.length === 0) continue;

        // Contar cuántas palabras del mensaje coinciden con el título
        let matchCount = 0;
        let specificCount = 0; // palabras NO genéricas que coinciden
        for (const cw of contentWords) {
          const cwNorm = stripAccents(cw);
          for (const tw of titleWords) {
            const twNorm = stripAccents(tw);
            let matched = false;
            // Match parcial: "entrada" ≈ "entrada", "limp" ⊂ "limpieza"
            if (twNorm.includes(cwNorm) || cwNorm.includes(twNorm)) {
              matched = true;
            }
            // Match por prefijo (≥5 chars): "supervision" ≈ "supervicion" (tolera typos)
            if (!matched && cwNorm.length >= 5 && twNorm.length >= 5 &&
                cwNorm.substring(0, 5) === twNorm.substring(0, 5)) {
              matched = true;
            }
            if (matched) {
              matchCount++;
              // Contar como "específica" si NO es palabra genérica
              if (!GENERIC_TASK_WORDS.has(cwNorm) && !GENERIC_TASK_WORDS.has(twNorm)) {
                specificCount++;
              }
              break;
            }
          }
        }

        // ── Filtro de calidad ──
        // Si TODAS las palabras coincidentes son genéricas (specificCount === 0),
        // necesitamos al menos 3 matches para aceptar (no 2)
        const minMatches = specificCount > 0 ? 2 : 3;
        const meetsThreshold = matchCount >= minMatches || (titleWords.length <= 2 && matchCount >= 1 && specificCount > 0);

        if (meetsThreshold && matchCount > bestScore) {
          bestScore = matchCount;
          bestMatch = task;
          bestSpecificCount = specificCount;
        }
      }

      if (bestMatch) {
        targetTask = bestMatch;
        matchMethod = 'fuzzy';
      }
    }
  }

  if (!targetTask) return null;

  // ─── Paso 2: Determinar qué acción quiere el usuario ──────────────
  let action = null;
  let progressPercent = null;

  // DONE (verificar ANTES que START para que "terminar tarea 3" gane sobre "voy a")
  // Incluye infinitivo ("terminar") y presente ("termina") además de pasado ("terminé")
  if (/(ya\s+)?termin(?:[eéo]|ar|a|ado|ada)\b|^listo$|^hecho$|^completado$|^ya$|acab(?:[eéo]|ar|a|ado|ada)\b|finalic[eé]|finaliza(?:r|do|da)?\b|ya\s+qued[oó]|ya\s+est[aá]\s*listo|marca(?:r|da|do)?\s+(?:como\s+)?(?:hecha|hecho|lista|listo|terminada|terminado|completada|completado)|dar\s+por\s+(?:termin|acab|finaliz)/i.test(cleanedLower)) {
    action = 'DONE';
  }
  // START: "empiezo", "inicio", "voy a", "estoy iniciando"
  else if (/empiezo|empec[eé]|inicio|inici[eé]|comienzo|comenc[eé]|arranco|arranqu[eé]|voy\s+a|estoy\s+iniciando|estoy\s+empezando|me\s+pongo/i.test(cleanedLower)) {
    action = 'START';
  }
  // PROGRESS RELATIVO: "10% más", "avancé un 20%", "le sumé 15%"
  // Checkear ANTES de absoluto para no perder el "más"
  else if (/(\d{1,3})\s*%\s*m[aá]s|avanc[eé]\s+(?:un\s+)?\d+\s*%|le\s+(?:sum[eé]|met[ií])\s+(?:un\s+)?\d+\s*%/i.test(cleanedLower)) {
    action = 'PROGRESS_RELATIVE';
    const relMatch = cleanedLower.match(/(\d{1,3})\s*%/);
    progressPercent = Math.min(parseInt(relMatch[1]), 100);
  }
  // PROGRESS con porcentaje absoluto: "50%", "al 80%"
  else if (/(\d{1,3})\s*(%|por\s*ciento)/i.test(cleanedLower)) {
    action = 'PROGRESS';
    const pctMatch = cleanedLower.match(/(\d{1,3})\s*(%|por\s*ciento)/);
    progressPercent = Math.min(parseInt(pctMatch[1]), 100);
  }
  // PROGRESS verbal: "a la mitad", "casi termino"
  else if (/(?:a\s+)?la\s+mitad|a\s+medias/i.test(cleanedLower)) {
    action = 'PROGRESS'; progressPercent = 50;
  }
  else if (/casi\s+(?:termin|list|acab)|ya\s+casi|falta\s+poco|ya\s+mero/i.test(cleanedLower)) {
    action = 'PROGRESS'; progressPercent = 85;
  }
  // BLOCKED: "bloqueada", "no puedo", "no funciona", "no hay", "no tengo", "detenido", "eliminar"
  else if (/bloquead[ao]|no\s+puedo|no\s+funciona|no\s+hay|no\s+tengo|no\s+sirve|deteni|atasc|estancad|parad[ao]|impedid|necesito\s+ayuda|sin\s+poder|no\s+alcanza|se\s+acab[oó]|eliminar/i.test(cleanedLower)) {
    action = 'BLOCKED';
  }
  // Referencia numérica sin verbo claro → NO asumir START.
  // Dejar que Claude/NLP desambigüe con el listado de tareas como contexto.
  else {
    logger.info('tryResolveTaskReference: referencia sin verbo claro, delegando a NLP', {
      text: cleanedLower, targetTask: targetTask?.title,
    });
    return null;
  }

  // ─── Paso 3: Ejecutar la acción ───────────────────────────────────
  const taskName = targetTask.title;

  if (action === 'START') {
    if (targetTask.status === 'done') {
      // Tarea ya completada → pedir confirmación antes de reiniciar
      await updateSessionState(session.session_id, 'WAITING_RESTART_CONFIRM', {
        instanceId: targetTask.instance_id,
        taskTitle: taskName,
      });
      return {
        reply: `⚠️ La tarea "*${taskName}*" ya está *completada*.\n\n¿Quieres reiniciarla? Responde *sí* o *no*.`,
        employee, instanceId: targetTask.instance_id,
      };
    }
    const wasBlocked = targetTask.status === 'blocked';
    if (targetTask.status === 'planned' || targetTask.status === 'blocked') {
      await taskService.startTask(targetTask.instance_id, employee.employee_id);
    }
    if (wasBlocked) {
      await notifyBlockerResolved(employee, workDate, taskName);
    }
    const startReply = await appendChecklistLink(targetTask.instance_id, employee.employee_id,
      `🔄 Iniciaste la tarea "*${taskName}*". Avísame cuando avances o termines.`);
    return {
      reply: startReply,
      employee, instanceId: targetTask.instance_id, intent: 'TASK_START',
    };
  }

  if (action === 'DONE') {
    // Backlog (📌): pedir confirmación solo si es tarea recurrente (daily/weekly/monthly)
    // Para once/adhoc no se pregunta — es válido terminarla en el día
    if (targetTask.task_id && session) {
      const freq = await taskService.getTaskFrequency(targetTask.task_id);
      if (freq && freq !== 'once' && freq !== 'adhoc') {
        await updateSessionState(session.session_id, 'WAITING_BACKLOG_DONE_CONFIRM', {
          instanceId: targetTask.instance_id,
          taskTitle: taskName,
          messageId,
        });
        return {
          reply: `📌 "*${taskName}*" es una tarea de largo plazo. ¿Estás seguro de que ya se completó *definitivamente*?\n\nResponde *sí* para confirmar o *no* para cancelar.`,
          employee, instanceId: targetTask.instance_id, intent: 'TASK_DONE',
        };
      }
    }
    // Verificar completado rápido
    const fastBlocked = await requireNormalCompletion(employee.employee_id, targetTask.instance_id, taskName, session, messageId);
    if (fastBlocked) return fastBlocked;
    await taskService.markTaskDone(targetTask.instance_id, employee.employee_id, messageId, null);
    const reply = await buildCompletionReply(taskName, employee.employee_id, workDate, shift?.shift_id, session);
    return { reply, employee, instanceId: targetTask.instance_id, intent: 'TASK_DONE' };
  }

  if ((action === 'PROGRESS' || action === 'PROGRESS_RELATIVE') && progressPercent !== null) {
    // Verificar que la tarea tenga time log abierto
    const blocked = await requireTaskStarted(employee.employee_id, targetTask.instance_id, taskName, session);
    if (blocked) return blocked;
    const isRelative = action === 'PROGRESS_RELATIVE';
    const result = await taskService.updateTaskProgress(targetTask.instance_id, progressPercent, employee.employee_id, messageId, null, { isRelative });
    const eff = result.effectivePercent || progressPercent;
    const emoji = eff >= 100 ? '✅' : eff >= 75 ? '💪' : eff >= 50 ? '👍' : '📊';
    let statusMsg;
    if (result.autoRelative) {
      statusMsg = `+${progressPercent}% → Ahora vas en ${eff}% (📌 sumado al avance anterior)`;
    } else if (isRelative) {
      statusMsg = `+${progressPercent}% → Ahora vas en ${eff}%`;
    } else {
      statusMsg = `Avance: ${eff}%`;
    }
    return {
      reply: `${emoji} Tarea "*${taskName}*" actualizada. ${statusMsg}`,
      employee, instanceId: targetTask.instance_id, intent: 'TASK_PROGRESS',
    };
  }

  if (action === 'BLOCKED') {
    // Extraer motivo: probar primero "bloqueada, MOTIVO" y si no matchea, probar "no tengo/puedo MOTIVO"
    let blockerText = null;
    const blockedMatch = cleanedLower.match(/bloquead[ao]\s*[,.:;]\s*(.+)/i);
    if (blockedMatch && blockedMatch[1].trim()) {
      blockerText = blockedMatch[1].trim(); // "la 2 bloqueada, no tengo producto" → "no tengo producto"
    } else {
      const noPuedoMatch = cleanedLower.match(/no\s+(?:puedo|hay|tengo|funciona|sirve|alcanza)\b.*/i);
      if (noPuedoMatch) {
        blockerText = noPuedoMatch[0].trim(); // Capturar TODO incluyendo "no tengo..."
      }
    }
    if (!blockerText) {
      // Último recurso: todo después de la referencia numérica
      blockerText = cleanedLower.replace(/^.*?\d+\s*,?\s*/, '').trim() || null;
    }

    if (blockerText) {
      await taskService.markTaskBlocked(targetTask.instance_id, employee.employee_id, messageId, blockerText);
      // Notificar supervisor (event_id = null, no es un event)
      const notifMsg = `⚠️ *Bloqueo reportado*\nEmpleado: ${employee.full_name}\nTarea: ${taskName}\nMotivo: ${blockerText}`;
      const escalation = await escalateToSupervisor(employee, workDate, 'BLOCKER_REPORTED', notifMsg, null);
      let reply = `⚠️ Tarea "*${taskName}*" marcada como bloqueada.\nMotivo: ${blockerText}`;
      if (escalation.notified) {
        reply += '\n\n✅ Se notificó a tu supervisor.';
      } else {
        reply += `\n\n⚠️ No se pudo notificar a tu supervisor (${escalation.reason}). Avísale directamente.`;
      }
      return { reply, employee, instanceId: targetTask.instance_id, intent: 'TASK_BLOCKED' };
    }
    // Sin motivo → preguntar
    return {
      reply: `¿Qué te está bloqueando en "*${taskName}*"? Describe el problema para notificar a tu supervisor.`,
      employee, instanceId: targetTask.instance_id, intent: 'TASK_BLOCKED',
    };
  }

  return null; // No se pudo resolver, dejar que NLP maneje
}

// ─── Intent handlers ─────────────────────────────────────────────────────────

async function handleGreeting(employee, workDate, shift) {
  const firstName = employee.full_name.split(' ')[0];
  const hour = new Date().getHours();
  const saludo = hour < 12 ? 'Buenos dias' : hour < 18 ? 'Buenas tardes' : 'Buenas noches';

  let msg = `${saludo}, ${firstName}! 👋\n`;

  if (shift) {
    if (shift._tooEarly) {
      msg += `Tu turno *${shift.shift_code}* empieza a las ${shift.start_time.substring(0, 5)} (faltan ~${shift._minutesUntilStart} min).\n`;
      msg += `Reportate cuando estés más cerca de tu hora de entrada.`;
      return msg;
    }
    msg += `Tu turno ${shift.shift_code} es de ${shift.start_time.substring(0, 5)} a ${shift.end_time.substring(0, 5)}.\n`;
  }

  msg += `Escribe *"me reporto"* para registrar entrada o *"mis tareas"* para ver tus tareas.`;
  return msg;
}

async function handleCheckIn(employee, workDate, shift, messageId, session) {
  const firstName = employee.full_name.split(' ')[0];

  // ─── Too early: shift exists but outside tolerance window ──────────
  if (shift && shift._tooEarly) {
    const startHHMM = shift.start_time.substring(0, 5);
    const mins = shift._minutesUntilStart;
    const hPart = Math.floor(mins / 60);
    const mPart = mins % 60;
    const timeLabel = hPart > 0
      ? `${hPart}h ${mPart > 0 ? mPart + 'min' : ''}`
      : `${mPart} minutos`;
    return `⏰ ${firstName}, tu turno *${shift.shift_code}* empieza a las *${startHHMM}* (faltan ~${timeLabel}).\n\nVuelve a reportarte cuando estés más cerca de tu hora de entrada.`;
  }

  // ─── Si requiere ubicacion → pedirla y esperar (estado WAITING_LOCATION) ─
  if (session && locationService.shouldRequireLocation(employee)) {
    await updateSessionState(session.session_id, 'WAITING_LOCATION', {
      checkType: 'start_day',
      shiftId: shift?.shift_id || null,
      messageId,
      requestedAt: new Date().toISOString(),
    });
    return `📍 ${firstName}, antes de registrar tu entrada necesito que compartas tu ubicación.\n\n` +
      `En Telegram: toca el clip 📎 → *Ubicación* → *Compartir mi ubicación actual*.\n\n` +
      `Si no puedes compartirla, responde *no puedo* y se registrará igual con una nota para tu supervisor.`;
  }

  // Sin requerimiento de ubicacion → check-in directo
  return await completeCheckIn(employee, workDate, shift, null);
}

// ─── Completar el check-in una vez resuelta la ubicacion ────────────────────
// locationInfo: null (no requerido) | objeto con datos de validacion
async function completeCheckIn(employee, workDate, shift, locationInfo) {
  const firstName = employee.full_name.split(' ')[0];

  await checkinService.registerCheckIn(employee.employee_id, workDate, shift, locationInfo);

  if (shift) {
    await taskService.generateDailyTaskInstances(employee.employee_id, workDate, shift.shift_id);
  }

  const tasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);

  let msg = `✅ Reporte registrado, ${firstName}!\n\n`;
  if (shift) {
    msg += `Turno: *${shift.shift_code}* (${shift.start_time.substring(0, 5)} - ${shift.end_time.substring(0, 5)})`;
    if (shift._early) {
      msg += ` — _llegaste ${shift._minutesUntilStart} min antes, ¡bien!_ 👏`;
    }
    msg += '\n\n';
  }

  // Anexar feedback de ubicacion si aplica
  if (locationInfo) {
    msg += formatLocationFeedback(locationInfo) + '\n\n';
  }

  msg += taskService.formatTaskList(tasks);
  msg += '\n\nPuedes decirme:\n• "Empiezo con [tarea]" para iniciar\n• "Ya terminé" al completar\n• Un porcentaje como "50%" para reportar avance';

  // ─── Escalonar anomalias de ubicacion ──────────────────────────────────
  if (locationInfo) {
    await maybeEscalateLocationAnomaly(employee, workDate, 'CHECK_IN', locationInfo);
  }

  return msg;
}

// ─── Mensaje legible sobre el resultado de validacion ──────────────────────
function formatLocationFeedback(loc) {
  switch (loc.status) {
    case 'valid':
      return `📍 Ubicación verificada (${loc.distance_m} m del centro autorizado).`;
    case 'out_of_range':
      return `⚠️ Ubicación fuera del rango autorizado (a ${loc.distance_m} m, máximo permitido ${loc.authorized_radius_m} m). Se notificó a tu supervisor.`;
    case 'low_accuracy':
      return `⚠️ La precisión de tu GPS es baja (${loc.accuracy_m} m). Se registró pero tu supervisor revisará.`;
    case 'not_shared':
      return `⚠️ No compartiste tu ubicación. Se notificó a tu supervisor.`;
    default:
      return '';
  }
}

// ─── Escalar al supervisor cuando hay anomalia de ubicacion ────────────────
async function maybeEscalateLocationAnomaly(employee, workDate, action, loc) {
  if (!loc || loc.status === 'valid' || loc.status === 'not_required') return;

  const actionLabel = action === 'CHECK_IN' ? 'Check-in' : 'Check-out';
  let reason, msg;

  if (loc.status === 'not_shared') {
    reason = 'CHECKIN_NO_LOCATION';
    msg = `📍 *${actionLabel} sin ubicación*\nEmpleado: ${employee.full_name}\nNo compartió su ubicación al hacer ${actionLabel.toLowerCase()}.`;
  } else if (loc.status === 'out_of_range') {
    reason = 'CHECKIN_LOCATION_INVALID';
    msg = `📍 *${actionLabel} fuera de rango*\nEmpleado: ${employee.full_name}\nDistancia: ${loc.distance_m} m (máximo ${loc.authorized_radius_m} m)\nCoordenadas: ${loc.lat?.toFixed(6)}, ${loc.lng?.toFixed(6)}\nGoogle Maps: https://maps.google.com/?q=${loc.lat},${loc.lng}`;
  } else if (loc.status === 'low_accuracy') {
    reason = 'CHECKIN_LOCATION_INVALID';
    msg = `📍 *${actionLabel} con baja precisión GPS*\nEmpleado: ${employee.full_name}\nPrecisión: ${loc.accuracy_m} m (radio permitido: ${loc.authorized_radius_m} m)\nCoordenadas: ${loc.lat?.toFixed(6)}, ${loc.lng?.toFixed(6)}`;
  } else {
    return;
  }

  try {
    await escalateToSupervisor(employee, workDate, reason, msg, null);
  } catch (err) {
    logger.warn('Location anomaly escalation failed (non-fatal)', { err: err.message });
  }
}

async function handleCheckOut(employee, workDate, shift, session) {
  const firstName = employee.full_name.split(' ')[0];

  // ─── Si requiere ubicacion → pedirla y esperar ─────────────────────────
  if (session && locationService.shouldRequireLocation(employee)) {
    await updateSessionState(session.session_id, 'WAITING_LOCATION', {
      checkType: 'end_day',
      shiftId: shift?.shift_id || null,
      requestedAt: new Date().toISOString(),
    });
    return `📍 ${firstName}, antes de registrar tu salida necesito que compartas tu ubicación.\n\n` +
      `En Telegram: toca el clip 📎 → *Ubicación* → *Compartir mi ubicación actual*.\n\n` +
      `Si no puedes compartirla, responde *no puedo* y se registrará igual con una nota para tu supervisor.`;
  }

  return await completeCheckOut(employee, workDate, shift, null);
}

// ─── Completar el check-out una vez resuelta la ubicacion ──────────────────
async function completeCheckOut(employee, workDate, shift, locationInfo) {
  const firstName = employee.full_name.split(' ')[0];

  // Register check-out
  await checkinService.registerCheckOut(employee.employee_id, workDate, 'manual', locationInfo);

  // Cerrar cualquier time log abierto al salir
  await taskService.stopTimeLog(employee.employee_id);

  // Get attendance summary (check-in and check-out times)
  const attendance = await checkinService.getAttendanceSummary(employee.employee_id, workDate);
  const checkInRecord = attendance.find(a => a.checkin_type === 'start_day');
  const checkOutRecord = attendance.find(a => a.checkin_type === 'end_day');

  // Get task summary (filtered by current shift)
  const tasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);
  const completed = tasks.filter(t => t.status === 'done').length;
  const total = tasks.length;
  const pending = tasks.filter(t => t.status === 'planned' || t.status === 'in_progress' || t.status === 'blocked');

  let msg = `👋 ¡Salida registrada, ${firstName}!\n\n`;

  // Attendance times
  if (checkInRecord) {
    const inTime = new Date(checkInRecord.answered_ts).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', hour12: false });
    const outTime = new Date(checkOutRecord.answered_ts).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', hour12: false });
    msg += `⏰ *Entrada:* ${inTime}\n`;
    msg += `⏰ *Salida:* ${outTime}\n`;

    // Calculate hours worked
    const diffMs = new Date(checkOutRecord.answered_ts) - new Date(checkInRecord.answered_ts);
    const hours = Math.floor(diffMs / 3600000);
    const minutes = Math.floor((diffMs % 3600000) / 60000);
    msg += `⏱️ *Tiempo trabajado:* ${hours}h ${minutes}m\n`;
  }

  if (shift) {
    msg += `📋 *Turno:* ${shift.shift_code} (${shift.start_time.substring(0, 5)} - ${shift.end_time.substring(0, 5)})\n`;
  }

  msg += `\n✅ *Tareas completadas:* ${completed} de ${total}`;

  if (pending.length > 0) {
    msg += `\n⚠️ *Pendientes sin completar:* ${pending.length}`;
    pending.forEach(t => msg += `\n  • ${t.title}`);
  }

  if (locationInfo) {
    msg += '\n\n' + formatLocationFeedback(locationInfo);
  }

  msg += '\n\n¡Buen trabajo hoy! Que descanses. 🌙';

  // ── Escalonar anomalia de ubicacion (si aplica) ─────────────────────────
  if (locationInfo) {
    await maybeEscalateLocationAnomaly(employee, workDate, 'CHECK_OUT', locationInfo);
  }

  // ── Alerta 4: Checkout antes de fin de turno → notificar supervisor ──
  if (shift && shift.end_time) {
    try {
      const now = new Date();
      const endTimeParts = shift.end_time.substring(0, 5).split(':');
      const shiftEnd = new Date(`${workDate}T${shift.end_time}`);
      // Manejar turnos nocturnos (end < start → sumar 24h)
      if (shift.end_time < shift.start_time) {
        shiftEnd.setDate(shiftEnd.getDate() + 1);
      }
      // Si sale más de 15 min antes del fin de turno → alertar
      const minutesEarly = (shiftEnd - now) / 60000;
      if (minutesEarly > 15) {
        const earlyMin = Math.round(minutesEarly);
        const endHHMM = shift.end_time.substring(0, 5);
        const notifMsg = `🚪 *Checkout temprano*\nEmpleado: ${employee.full_name}\nTurno termina: ${endHHMM}\nSalió ${earlyMin} min antes de su hora de salida.\nTareas completadas: ${completed}/${total}`;
        await escalateToSupervisor(employee, workDate, 'EARLY_CHECKOUT', notifMsg, null);
      }
    } catch (err) {
      logger.warn('Early checkout alert failed (non-fatal)', { err: err.message });
    }
  }

  return msg;
}

async function handleStillWorking(employee, workDate, shift) {
  const firstName = employee.full_name.split(' ')[0];
  const autoCloseMinutes = parseInt(process.env.AUTO_CHECKOUT_CLOSE_MINUTES || '20');

  // Check if there's an end_day reminder pending
  const endDayRecord = await checkinService.getEndDayRecord(employee.employee_id, workDate);

  if (endDayRecord && endDayRecord.status === 'sent') {
    // Extend the deadline — reset scheduled_ts to NOW()
    await checkinService.extendCheckoutDeadline(employee.employee_id, workDate);

    // Get remaining tasks info (filtered by current shift)
    const tasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);
    const pending = tasks.filter(t => t.status === 'planned' || t.status === 'in_progress' || t.status === 'blocked');

    let msg = `👍 Entendido ${firstName}, sigue con lo tuyo.\n\n`;
    msg += `Te volveré a preguntar en *${autoCloseMinutes} minutos*.\n`;

    if (pending.length > 0) {
      msg += `\n📋 *Tareas pendientes:*\n`;
      pending.forEach((t, i) => {
        const status = t.status === 'in_progress' ? '🔄' : t.status === 'blocked' ? '🔴' : '⬜';
        msg += `${status} ${t.title}`;
        if (t.progress_percent > 0) msg += ` (${t.progress_percent}%)`;
        msg += '\n';
      });
    }

    msg += `\nCuando termines, escribe *"ya me voy"*.`;
    return msg;
  }

  // No pending end-of-shift reminder — just acknowledge
  return `${firstName}, tu respuesta fue registrada. Sigue trabajando y avísame cuando termines tu turno con *"ya me voy"*.`;
}

async function handleTaskListRequest(employee, workDate, shift) {
  if (shift) {
    await taskService.generateDailyTaskInstances(employee.employee_id, workDate, shift.shift_id);
  }
  const tasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);
  return taskService.formatTaskList(tasks);
}

async function handleTaskDone(employee, workDate, activeTask, messageId, nlpResult, session, shift) {
  // Helper: si es backlog recurrente (daily/weekly/monthly), pedir confirmación
  // Para once/adhoc no se pregunta — es válido terminarla en el día
  const askBacklogConfirm = async (task) => {
    if (task.task_id) {
      const freq = await taskService.getTaskFrequency(task.task_id);
      if (freq && freq !== 'once' && freq !== 'adhoc') {
        await updateSessionState(session.session_id, 'WAITING_BACKLOG_DONE_CONFIRM', {
          instanceId: task.instance_id,
          taskTitle: task.title,
          messageId,
        });
        return {
          reply: `📌 "*${task.title}*" es una tarea de largo plazo. ¿Estás seguro de que ya se completó *definitivamente*?\n\nResponde *sí* para confirmar o *no* para cancelar.`,
          instanceId: task.instance_id,
        };
      }
    }
    return null;
  };

  // ─── Guardia: múltiples tareas en progreso sin referencia explícita ──────
  // Si hay 2+ tareas 'in_progress' y el mensaje no menciona ninguna por nombre/número,
  // NO asumir cuál quiso terminar. Preguntar qué tarea específicamente.
  const origTextRaw = nlpResult.originalText || '';
  const origTextLower = origTextRaw.toLowerCase();
  const hasExplicitRef = /\d+|tarea\s+\w+|la\s+(primera|segunda|tercera|[uú]ltima|anterior)/i.test(origTextLower)
    || !!nlpResult.entities?.task_title
    || /tod[ao]s/i.test(origTextLower);

  if (!hasExplicitRef) {
    const inProgress = await taskService.getInProgressTasks(employee.employee_id, workDate);
    if (inProgress.length > 1) {
      const list = inProgress
        .map((t, i) => `*${i + 1}.* ${t.title} (${t.progress_percent || 0}%)`)
        .join('\n');
      await updateSessionState(session.session_id, 'WAITING_TASK_PICK', {
        action: 'TASK_DONE',
        taskOptions: inProgress.map(t => ({
          id: t.instance_id,
          title: t.title,
          task_id: t.task_id || null,
        })),
        messageId,
      });
      return {
        reply: `Tienes ${inProgress.length} tareas en progreso. ¿Cuál terminaste?\n\n${list}\n\nResponde con el número, varios números (ej: 1,2), o "todas".`,
        instanceId: null,
      };
    }
  }

  // If there's an active task, mark it as done
  if (activeTask) {
    const confirm = await askBacklogConfirm(activeTask);
    if (confirm) return confirm;
    const fastBlocked = await requireNormalCompletion(employee.employee_id, activeTask.instance_id, activeTask.title, session, messageId);
    if (fastBlocked) return fastBlocked;
    await taskService.markTaskDone(activeTask.instance_id, employee.employee_id, messageId, nlpResult.entities?.note_text);
    const completionReply = await buildCompletionReply(activeTask.title, employee.employee_id, workDate, shift?.shift_id, session);
    return {
      reply: completionReply,
      instanceId: activeTask.instance_id,
    };
  }

  // If there's a task title in the NLP result, try to find it
  if (nlpResult.entities?.task_title) {
    const found = await taskService.findTaskByFuzzyTitle(employee.employee_id, workDate, nlpResult.entities.task_title);
    if (found) {
      const confirm = await askBacklogConfirm(found);
      if (confirm) return confirm;
      const fastBlocked = await requireNormalCompletion(employee.employee_id, found.instance_id, found.title, session, messageId);
      if (fastBlocked) return fastBlocked;
      await taskService.markTaskDone(found.instance_id, employee.employee_id, messageId, null);
      const completionReply2 = await buildCompletionReply(found.title, employee.employee_id, workDate, shift?.shift_id, session);
      return {
        reply: completionReply2,
        instanceId: found.instance_id,
      };
    }
  }

  // Get all non-done tasks (including blocked!) — filtered by current shift
  const tasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);
  const pending = tasks.filter((t) => t.status === 'planned' || t.status === 'in_progress' || t.status === 'blocked');

  // Try to find task by number reference ("el 1", "tarea 1", "la primera", etc.)
  const taskByNumber = findTaskByNumberRef(nlpResult.originalText || '', tasks, pending);
  if (taskByNumber) {
    const confirm = await askBacklogConfirm(taskByNumber);
    if (confirm) return confirm;
    const fastBlocked = await requireNormalCompletion(employee.employee_id, taskByNumber.instance_id, taskByNumber.title, session, messageId);
    if (fastBlocked) return fastBlocked;
    await taskService.markTaskDone(taskByNumber.instance_id, employee.employee_id, messageId, null);
    const completionReply3 = await buildCompletionReply(taskByNumber.title, employee.employee_id, workDate, shift?.shift_id, session);
    return {
      reply: completionReply3,
      instanceId: taskByNumber.instance_id,
    };
  }

  if (pending.length === 0) {
    return { reply: 'No tienes tareas pendientes. ¿Quieres crear una nueva? Dime "voy a hacer [descripcion]".', instanceId: null };
  }

  const origText = nlpResult.originalText || '';

  // ─── "Terminé todas" / "todas las tareas" → complete ALL pending ──────────
  // Para backlog tasks: las excluye y avisa
  if (/tod[ao]s/i.test(origText) && pending.length > 0) {
    const regularTasks = pending.filter(t => !t.task_id);
    const backlogTasks = pending.filter(t => t.task_id);
    let completedNames = [];
    let lastId = null;
    for (const t of regularTasks) {
      const fastBlocked = await requireNormalCompletion(employee.employee_id, t.instance_id, t.title, session, messageId);
      if (fastBlocked) return fastBlocked;
      await taskService.markTaskDone(t.instance_id, employee.employee_id, messageId, null);
      completedNames.push(t.title);
      lastId = t.instance_id;
    }
    let msg = '';
    if (completedNames.length > 0) {
      msg += `✅ *${completedNames.length} tareas completadas:*\n`;
      completedNames.forEach(name => msg += `• ${name}\n`);
    }
    if (backlogTasks.length > 0) {
      msg += `\n📌 *${backlogTasks.length} tarea(s) de largo plazo NO se completaron automáticamente:*\n`;
      backlogTasks.forEach(t => msg += `• ${t.title}\n`);
      msg += '\nPara completar una tarea de largo plazo, dime "terminé [nombre]" y te pediré confirmación.';
    }
    if (completedNames.length > 0 && backlogTasks.length === 0) {
      msg += '\n🎉 ¡Excelente trabajo! No tienes más tareas pendientes.';
    }
    return { reply: msg, instanceId: lastId };
  }

  // ─── "Terminé 1, 2, 3" → complete multiple by number ─────────────────────
  const multiNums = origText.match(/\d+/g);
  if (multiNums && multiNums.length > 1) {
    const nums = multiNums.map(n => parseInt(n)).filter(n => n >= 1 && n <= tasks.length);
    const uniqueNums = [...new Set(nums)];
    if (uniqueNums.length > 0) {
      let completedNames = [];
      let skippedBacklog = [];
      let lastId = null;
      for (const n of uniqueNums) {
        const t = tasks[n - 1];
        if (t && (t.status === 'planned' || t.status === 'in_progress' || t.status === 'blocked')) {
          if (t.task_id) {
            skippedBacklog.push(t.title);
          } else {
            const fastBlocked = await requireNormalCompletion(employee.employee_id, t.instance_id, t.title, session, messageId);
            if (fastBlocked) return fastBlocked;
            await taskService.markTaskDone(t.instance_id, employee.employee_id, messageId, null);
            completedNames.push(t.title);
            lastId = t.instance_id;
          }
        }
      }
      if (completedNames.length > 0 || skippedBacklog.length > 0) {
        let msg = '';
        if (completedNames.length > 0) {
          const remainingPending = pending.filter(p => !completedNames.includes(p.title));
          msg += `✅ *${completedNames.length} tareas completadas:*\n`;
          completedNames.forEach(name => msg += `• ${name}\n`);
          if (remainingPending.length > 0) {
            msg += `\nAún quedan ${remainingPending.length} tarea(s) pendientes:\n`;
            remainingPending.forEach((t, i) => msg += `*${i + 1}.* ${t.title}\n`);
            msg += '\n¿Completaste alguna más? Responde con el número, "todas", o "mis tareas".';
            await updateSessionState(session.session_id, 'WAITING_TASK_PICK', {
              action: 'TASK_DONE',
              taskOptions: remainingPending.map(t => ({ id: t.instance_id, title: t.title, task_id: t.task_id })),
              messageId,
            });
          } else {
            msg += '\n🎉 ¡Excelente trabajo!';
          }
        }
        if (skippedBacklog.length > 0) {
          msg += `\n📌 Tareas de largo plazo requieren confirmación individual:\n`;
          skippedBacklog.forEach(name => msg += `• ${name}\n`);
        }
        return { reply: msg, instanceId: lastId };
      }
    }
  }

  if (pending.length === 1) {
    const confirm = await askBacklogConfirm(pending[0]);
    if (confirm) return confirm;
    const fastBlocked = await requireNormalCompletion(employee.employee_id, pending[0].instance_id, pending[0].title, session, messageId);
    if (fastBlocked) return fastBlocked;
    await taskService.markTaskDone(pending[0].instance_id, employee.employee_id, messageId, null);
    return {
      reply: `✅ Tarea "*${pending[0].title}*" completada!`,
      instanceId: pending[0].instance_id,
    };
  }

  // Multiple tasks - ask which one
  let msg = '¿Cuál tarea completaste? Responde con el número, "todas", o varios números (ej: 1, 3, 5):\n\n';
  pending.forEach((t, i) => msg += `*${i + 1}.* ${t.title}\n`);

  await updateSessionState(session.session_id, 'WAITING_TASK_PICK', {
    action: 'TASK_DONE',
    taskOptions: pending.map((t) => ({ id: t.instance_id, title: t.title, task_id: t.task_id || null })),
    messageId,
  });

  return { reply: msg, instanceId: null };
}

async function handleTaskProgress(employee, workDate, activeTask, messageId, nlpResult, session, shift) {
  const percent = nlpResult.entities?.progress_percent;

  if (!percent && percent !== 0) {
    // We detected progress intent but no percentage
    return {
      reply: '¿Cuánto llevas de avance? Dame un porcentaje (ej: 50%, 75%).',
      instanceId: null,
    };
  }

  const isRelative = !!nlpResult.entities?.is_relative;
  const originalText = (nlpResult.originalText || '').toLowerCase();

  // ── Si el usuario mencionó un nombre de tarea, buscarla primero (no asumir la activa) ──
  // Ej: "avance 7% más con las cristaleras del CC" → buscar "cristaleras" antes de usar activeTask
  if (activeTask && originalText.length > 0) {
    const tasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);
    const msgWords = originalText.split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
    const contentWords = msgWords.filter(w => !ACTION_WORDS.has(w));

    if (contentWords.length >= 1) {
      let bestMatch = null;
      let bestScore = 0;
      for (const task of tasks) {
        if (task.status === 'done' || task.status === 'canceled') continue;
        const titleWords = task.title.toLowerCase().split(/\s+/)
          .filter(w => w.length > 2 && !STOP_WORDS.has(w));
        if (titleWords.length === 0) continue;
        let matchCount = 0;
        for (const cw of contentWords) {
          const cwNorm = stripAccents(cw);
          for (const tw of titleWords) {
            const twNorm = stripAccents(tw);
            if (twNorm.includes(cwNorm) || cwNorm.includes(twNorm)) { matchCount++; break; }
            if (cwNorm.length >= 5 && twNorm.length >= 5 &&
                cwNorm.substring(0, 5) === twNorm.substring(0, 5)) { matchCount++; break; }
          }
        }
        if ((matchCount >= 2 || (titleWords.length <= 2 && matchCount >= 1)) && matchCount > bestScore) {
          bestScore = matchCount;
          bestMatch = task;
        }
      }

      // Si encontramos una tarea por nombre Y no es la activa → usar la encontrada
      if (bestMatch && bestMatch.instance_id !== activeTask.instance_id) {
        logger.info('handleTaskProgress: name match overrides active task', {
          mentioned: bestMatch.title, active: activeTask.title, score: bestScore,
        });
        // Verificar que la tarea tenga time log abierto
        const blocked = await requireTaskStarted(employee.employee_id, bestMatch.instance_id, bestMatch.title, session);
        if (blocked) return blocked;
        const result = await taskService.updateTaskProgress(bestMatch.instance_id, percent, employee.employee_id, messageId, nlpResult.entities?.note_text, { isRelative });
        const eff = result.effectivePercent || percent;
        const emoji = eff >= 100 ? '✅' : eff >= 75 ? '💪' : eff >= 50 ? '👍' : '📊';
        let statusMsg;
        if (result.autoRelative) {
          statusMsg = `+${percent}% → Ahora vas en ${eff}% (📌 sumado al avance anterior)`;
        } else if (isRelative) {
          statusMsg = `+${percent}% → Ahora vas en ${eff}%`;
        } else {
          statusMsg = `Avance: ${eff}%`;
        }
        return {
          reply: `${emoji} Tarea "*${bestMatch.title}*" actualizada. ${statusMsg}`,
          instanceId: bestMatch.instance_id,
        };
      }
    }
  }

  if (activeTask) {
    // Verificar que la tarea tenga time log abierto
    const blocked = await requireTaskStarted(employee.employee_id, activeTask.instance_id, activeTask.title, session);
    if (blocked) return blocked;
    const result = await taskService.updateTaskProgress(activeTask.instance_id, percent, employee.employee_id, messageId, nlpResult.entities?.note_text, { isRelative });
    const eff = result.effectivePercent || percent;
    const emoji = eff >= 100 ? '✅' : eff >= 75 ? '💪' : eff >= 50 ? '👍' : '📊';
    const statusMsg = eff >= 100 ? 'Completada!' : isRelative ? `+${percent}% → Ahora vas en ${eff}%` : `Avance: ${eff}%`;
    return {
      reply: `${emoji} Tarea "*${activeTask.title}*" actualizada. ${statusMsg}`,
      instanceId: activeTask.instance_id,
    };
  }

  // No active task — try to find by number reference first ("la 1 voy a la mitad")
  const tasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);
  const pending = tasks.filter((t) => t.status !== 'done' && t.status !== 'canceled');

  if (pending.length === 0) {
    return { reply: 'No tienes tareas activas. ¿Quieres crear una? Dime "voy a hacer [descripcion]".', instanceId: null };
  }

  // Try to identify task by number/ordinal ("la 1 a la mitad", "tarea 2 al 50%")
  const taskByNum = findTaskByNumberRef(nlpResult.originalText || '', tasks, pending);
  if (taskByNum && (taskByNum.status !== 'done' && taskByNum.status !== 'canceled')) {
    // Verificar que la tarea tenga time log abierto
    const blocked = await requireTaskStarted(employee.employee_id, taskByNum.instance_id, taskByNum.title, session);
    if (blocked) return blocked;
    const result = await taskService.updateTaskProgress(taskByNum.instance_id, percent, employee.employee_id, messageId, nlpResult.entities?.note_text, { isRelative });
    const eff = result.effectivePercent || percent;
    const emoji = eff >= 100 ? '✅' : eff >= 75 ? '💪' : eff >= 50 ? '👍' : '📊';
    const statusMsg = eff >= 100 ? 'Completada!' : isRelative ? `+${percent}% → Ahora vas en ${eff}%` : `Avance: ${eff}%`;
    return {
      reply: `${emoji} Tarea "*${taskByNum.title}*" actualizada. ${statusMsg}`,
      instanceId: taskByNum.instance_id,
    };
  }

  if (pending.length === 1) {
    // Verificar que la tarea tenga time log abierto
    const blocked = await requireTaskStarted(employee.employee_id, pending[0].instance_id, pending[0].title, session);
    if (blocked) return blocked;
    const result = await taskService.updateTaskProgress(pending[0].instance_id, percent, employee.employee_id, messageId, null, { isRelative });
    const eff = result.effectivePercent || percent;
    const statusMsg = isRelative ? `+${percent}% → Ahora vas en ${eff}%` : `Avance: ${eff}%`;
    return {
      reply: `📊 Tarea "*${pending[0].title}*" actualizada. ${statusMsg}`,
      instanceId: pending[0].instance_id,
    };
  }

  let msg = `¿A cuál tarea le pongo ${isRelative ? '+' : ''}${percent}% de avance?\n\n`;
  pending.forEach((t, i) => msg += `*${i + 1}.* ${t.title} (${t.progress_percent || 0}%)\n`);

  await updateSessionState(session.session_id, 'WAITING_TASK_PICK', {
    action: 'TASK_PROGRESS',
    percent,
    isRelative,
    taskOptions: pending.map((t) => ({ id: t.instance_id, title: t.title, task_id: t.task_id || null })),
    messageId,
  });

  return { reply: msg, instanceId: null };
}

async function handleTaskBlocked(employee, workDate, activeTask, messageId, nlpResult, session) {
  const blockerText = nlpResult.entities?.blocker_text || nlpResult.entities?.note_text;

  if (activeTask) {
    if (!blockerText) {
      await updateSessionState(session.session_id, 'WAITING_WRAPUP', {
        action: 'TASK_BLOCKED',
        instanceId: activeTask.instance_id,
        messageId,
      });
      return {
        reply: `¿Qué te está bloqueando en "*${activeTask.title}*"? Describe el problema para notificar a tu supervisor.`,
        instanceId: null,
      };
    }

    await taskService.markTaskBlocked(activeTask.instance_id, employee.employee_id, messageId, blockerText);

    // Notify supervisor via escalation helper (event_id = null, no es un event)
    const notifMsg = `⚠️ *Bloqueo reportado*\nEmpleado: ${employee.full_name}\nTarea: ${activeTask.title}\nMotivo: ${blockerText}`;
    const escalation = await escalateToSupervisor(employee, workDate, 'BLOCKER_REPORTED', notifMsg, null);

    let reply = `⚠️ Tarea "*${activeTask.title}*" marcada como bloqueada.\nMotivo: ${blockerText}`;
    if (escalation.notified) {
      reply += '\n\n✅ Se notificó a tu supervisor.';
    } else {
      reply += `\n\n⚠️ No se pudo notificar a tu supervisor (${escalation.reason}). Avísale directamente.`;
    }

    return { reply, instanceId: activeTask.instance_id };
  }

  return {
    reply: 'No tienes una tarea activa. ¿Cuál tarea está bloqueada? Dime el nombre.',
    instanceId: null,
  };
}

async function handleTaskCreate(employee, workDate, shift, messageId, nlpResult, session) {
  const title = nlpResult.entities?.task_title;

  if (!title) {
    await updateSessionState(session.session_id, 'WAITING_PLAN', {
      action: 'TASK_CREATE',
      messageId,
    });
    return { reply: '¿Qué tarea vas a hacer? Describe brevemente.', instanceId: null };
  }

  // ─── Before creating new: check if title references an EXISTING task ────
  // "la 2", "tarea 3", "#1" → start existing task instead of creating duplicate
  const existingTasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);

  // Try number reference from title first, then from originalText
  const refTask = findTaskByNumberRef(title, existingTasks, existingTasks)
    || findTaskByNumberRef(nlpResult.originalText || '', existingTasks, existingTasks);

  if (refTask) {
    if (refTask.status === 'done') {
      // Tarea ya completada → pedir confirmación antes de reiniciar
      await updateSessionState(session.session_id, 'WAITING_RESTART_CONFIRM', {
        instanceId: refTask.instance_id,
        taskTitle: refTask.title,
      });
      return {
        reply: `⚠️ La tarea "*${refTask.title}*" ya está *completada*.\n\n¿Quieres reiniciarla? Responde *sí* o *no*.`,
        instanceId: refTask.instance_id,
      };
    }
    if (refTask.status !== 'canceled') {
      const wasBl3 = refTask.status === 'blocked';
      if (refTask.status === 'planned' || refTask.status === 'blocked') {
        await taskService.startTask(refTask.instance_id, employee.employee_id);
      }
      if (wasBl3) await notifyBlockerResolved(employee, workDate, refTask.title);
      const rply = await appendChecklistLink(refTask.instance_id, employee.employee_id,
        `🔄 Iniciaste la tarea "*${refTask.title}*". Avísame cuando avances o termines.`);
      return {
        reply: rply,
        instanceId: refTask.instance_id,
      };
    }
  }

  // Also check by fuzzy name match ("la limpieza de baños" → "Limpieza Baños Hombres...")
  // Use findTaskByTitleAnyStatus to also catch done tasks
  const fuzzyMatch = await taskService.findTaskByTitleAnyStatus(employee.employee_id, workDate, title);
  if (fuzzyMatch) {
    if (fuzzyMatch.status === 'done') {
      // Tarea ya completada → pedir confirmación antes de reiniciar
      await updateSessionState(session.session_id, 'WAITING_RESTART_CONFIRM', {
        instanceId: fuzzyMatch.instance_id,
        taskTitle: fuzzyMatch.title,
      });
      return {
        reply: `⚠️ La tarea "*${fuzzyMatch.title}*" ya está *completada*.\n\n¿Quieres reiniciarla? Responde *sí* o *no*.`,
        instanceId: fuzzyMatch.instance_id,
      };
    }
    if (fuzzyMatch.status !== 'canceled') {
      const wasBl4 = fuzzyMatch.status === 'blocked';
      if (fuzzyMatch.status === 'planned' || fuzzyMatch.status === 'blocked') {
        await taskService.startTask(fuzzyMatch.instance_id, employee.employee_id);
      }
      if (wasBl4) await notifyBlockerResolved(employee, workDate, fuzzyMatch.title);
      const rply2 = await appendChecklistLink(fuzzyMatch.instance_id, employee.employee_id,
        `🔄 Iniciaste la tarea "*${fuzzyMatch.title}*". Avísame cuando avances o termines.`);
      return {
        reply: rply2,
        instanceId: fuzzyMatch.instance_id,
      };
    }
  }

  // No existing match — ask for confirmation before creating
  // Check if the original message includes a time estimate ("voy a hacer limpieza, como 45 min")
  const initialEstimate = extractTimeEstimate(nlpResult.originalText || text);

  await updateSessionState(session.session_id, 'WAITING_ADHOC_CONFIRM', {
    title,
    shiftId: shift?.shift_id || null,
    description: null,
    pendingPhotos: [],
    estimateMinutes: initialEstimate,
  });

  return {
    reply: `📋 ¿Confirmas nueva tarea: "*${title}*"?\nPuedes agregar detalles, enviar fotos, o responde *sí* para iniciar.`,
    instanceId: null,
  };
}

async function handleTaskStart(employee, workDate, messageId, nlpResult, shift, session) {
  const taskTitle = nlpResult.entities?.task_title;
  if (!taskTitle) {
    return { reply: '¿Cuál tarea quieres iniciar?', instanceId: null };
  }

  // Try by number reference first ("la 2", "tarea 3")
  const tasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);
  const refTask = findTaskByNumberRef(nlpResult.originalText || taskTitle, tasks, tasks);

  // ─── Guardia: si hay tareas en progreso, pedir confirmación antes de iniciar otra ──
  // Evita que el empleado quede con 2+ tareas abiertas en paralelo sin saberlo.
  // Se resuelve primero cuál tarea quiere iniciar (refTask o fuzzy) y se compara
  // contra la lista de in_progress: si es distinta, preguntamos qué hacer con la actual.
  const inProgressList = await taskService.getInProgressTasks(employee.employee_id, workDate);
  if (inProgressList.length > 0) {
    // Buscar la tarea objetivo para decidir si hay conflicto real
    let targetForSwitch = refTask;
    if (!targetForSwitch) {
      targetForSwitch = await taskService.findTaskByTitleAnyStatus(employee.employee_id, workDate, taskTitle);
    }
    const targetId = targetForSwitch?.instance_id;
    const alreadyInProgress = targetId && inProgressList.some(t => t.instance_id === targetId);

    // Solo preguntar si la tarea objetivo NO es una de las que ya están en progreso,
    // y además existe (si no existe, el flujo normal la creará/avisará).
    if (targetForSwitch && !alreadyInProgress &&
        targetForSwitch.status !== 'done' && targetForSwitch.status !== 'canceled') {
      await updateSessionState(session.session_id, 'WAITING_SWITCH_CONFIRM', {
        pendingStartId: targetForSwitch.instance_id,
        pendingStartTitle: targetForSwitch.title,
        currentInProgress: inProgressList.map(t => ({
          id: t.instance_id,
          title: t.title,
          pct: t.progress_percent || 0,
        })),
        messageId,
      });
      const list = inProgressList
        .map((t, i) => `*${i + 1}.* ${t.title} (${t.progress_percent || 0}%)`)
        .join('\n');
      const plural = inProgressList.length > 1 ? 's' : '';
      return {
        reply: `⚠️ Ya tienes ${inProgressList.length} tarea${plural} en progreso:\n${list}\n\n¿Qué hago con "*${targetForSwitch.title}*"?\n• *pausar* → pauso la${plural} actual${plural} y empiezo la nueva\n• *terminar N* → marco como hecha la tarea N y empiezo la nueva\n• *simultáneo* → trabajo las dos en paralelo\n• *cancelar* → no inicio la nueva`,
        instanceId: null,
      };
    }
  }

  if (refTask) {
    if (refTask.status === 'done') {
      // Tarea ya completada → pedir confirmación antes de reiniciar
      await updateSessionState(session.session_id, 'WAITING_RESTART_CONFIRM', {
        instanceId: refTask.instance_id,
        taskTitle: refTask.title,
      });
      return {
        reply: `⚠️ La tarea "*${refTask.title}*" ya está *completada*.\n\n¿Quieres reiniciarla? Responde *sí* o *no*.`,
        instanceId: refTask.instance_id,
      };
    }
    if (refTask.status !== 'canceled') {
      const wasBl5 = refTask.status === 'blocked';
      if (refTask.status === 'planned' || refTask.status === 'blocked') {
        await taskService.startTask(refTask.instance_id, employee.employee_id);
      }
      if (wasBl5) await notifyBlockerResolved(employee, workDate, refTask.title);
      const rply5 = await appendChecklistLink(refTask.instance_id, employee.employee_id,
        `🔄 Iniciaste la tarea "*${refTask.title}*". Avísame cuando avances o termines.`);
      return {
        reply: rply5,
        instanceId: refTask.instance_id,
      };
    }
  }

  // Try by fuzzy title match (any status)
  const found = await taskService.findTaskByTitleAnyStatus(employee.employee_id, workDate, taskTitle);
  if (found) {
    if (found.status === 'done') {
      // Tarea ya completada → pedir confirmación antes de reiniciar
      await updateSessionState(session.session_id, 'WAITING_RESTART_CONFIRM', {
        instanceId: found.instance_id,
        taskTitle: found.title,
      });
      return {
        reply: `⚠️ La tarea "*${found.title}*" ya está *completada*.\n\n¿Quieres reiniciarla? Responde *sí* o *no*.`,
        instanceId: found.instance_id,
      };
    }
    if (found.status !== 'canceled') {
      const wasBl6 = found.status === 'blocked';
      if (found.status === 'planned' || found.status === 'blocked') {
        await taskService.startTask(found.instance_id, employee.employee_id);
      }
      if (wasBl6) await notifyBlockerResolved(employee, workDate, found.title);
      const rply6 = await appendChecklistLink(found.instance_id, employee.employee_id,
        `🔄 Iniciaste la tarea "*${found.title}*". Avísame cuando avances o termines.`);
      return {
        reply: rply6,
        instanceId: found.instance_id,
      };
    }
  }

  return { reply: `No encontré una tarea llamada "${taskTitle}". ¿Quieres crearla como nueva? Di "voy a hacer ${taskTitle}".`, instanceId: null };
}

async function handleVagueMessage(employee, activeTask) {
  const firstName = employee.full_name.split(' ')[0];

  if (activeTask) {
    return `${firstName}, veo que tienes la tarea "*${activeTask.title}*" en progreso (${activeTask.progress_percent || 0}%).\n\n¿Puedes darme más detalles?\n• Un porcentaje de avance (ej: "75%")\n• "Ya terminé" si la completaste\n• "Bloqueado" si tienes algún impedimento`;
  }

  return `${firstName}, necesito un poco más de detalle. Puedes decirme:\n• "Me reporto" para iniciar tu jornada\n• "Mis tareas" para ver tus pendientes\n• "Voy a hacer [tarea]" para crear una nueva tarea\n• Un porcentaje como "50%" para reportar avance`;
}

async function handleUnknown(employee, text, activeTask) {
  const firstName = employee.full_name.split(' ')[0];
  const isManager = ['manager', 'admin', 'general_supervisor', 'supervisor_auditor'].includes(employee.role);

  if (activeTask) {
    let msg = `${firstName}, no entendí bien tu mensaje. Tienes la tarea "*${activeTask.title}*" activa.\n\n¿Quieres:\n• Reportar avance? (di un porcentaje)\n• Marcarla como completada? (di "listo")\n• Reportar un bloqueo? (di "bloqueado")`;
    if (isManager) msg += `\n\n👔 *Como supervisor también puedes:*\n• "Dashboard" - Resumen del día\n• "Asistencia" - Quién ha llegado\n• "Avance del equipo" - Estado de tareas\n• "Productividad" - Tiempos reales vs estándar\n• "Turnos de hoy" - Ver turnos, personal y sus tareas`;
    return msg;
  }

  let msg = `${firstName}, no entendí tu mensaje. Puedo ayudarte con:\n• "Me reporto" - Registrar tu llegada\n• "Mis tareas" - Ver tus tareas del dia\n• "Voy a hacer [algo]" - Crear nueva tarea\n• "[número]%" - Reportar avance`;
  if (isManager) msg += `\n\n👔 *Opciones de supervisor:*\n• "Dashboard" - Resumen del día\n• "Asistencia" - Quién ha llegado\n• "Avance del equipo" - Estado de tareas\n• "Productividad" - Tiempos reales vs estándar\n• "Turnos de hoy" - Ver turnos, personal y sus tareas`;
  return msg;
}

// ─── Manager-only handlers ──────────────────────────────────────────────────

async function handleAssignTask(employee) {
  const firstName = employee.full_name.split(' ')[0];
  try {
    const token = await taskService.generateSupervisorAssignmentToken(employee.employee_id);
    const MOBILE_BASE_URL = (process.env.MOBILE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const link = `${MOBILE_BASE_URL}/m/assign/${token}`;
    return `${firstName}, aquí tienes el enlace para asignar una tarea:\n\n🔗 ${link}\n\n⏱️ El enlace expira en 2 horas.`;
  } catch (err) {
    logger.error('handleAssignTask failed', { err: err.message });
    return 'Hubo un error generando el enlace. Intenta de nuevo.';
  }
}

async function handleManagerDashboard(employee, workDate) {
  const firstName = employee.full_name.split(' ')[0];

  // Get attendance data
  const attendance = await checkinService.getTeamAttendanceReport(workDate);
  const checkedIn = attendance.filter(a => a.has_checked_in);
  const notCheckedIn = attendance.filter(a => !a.has_checked_in);
  const checkedOut = attendance.filter(a => a.has_checked_out);

  // Get task data
  const taskSummary = await taskService.getTeamTaskSummary(workDate);
  const prodReport = await taskService.getTeamProductivityReport(workDate);
  let totalTasks = 0, totalDone = 0, totalInProgress = 0, totalBlocked = 0, totalPlanned = 0;
  for (const emp of taskSummary) {
    totalTasks += parseInt(emp.total_tasks) || 0;
    totalDone += parseInt(emp.done_count) || 0;
    totalInProgress += parseInt(emp.in_progress_count) || 0;
    totalBlocked += parseInt(emp.blocked_count) || 0;
    totalPlanned += parseInt(emp.planned_count) || 0;
  }
  // Time totals
  let totalActualSecs = 0;
  for (const emp of prodReport) {
    totalActualSecs += (parseInt(emp.actual_seconds) || 0) + (parseInt(emp.current_open_seconds) || 0);
  }

  const hour = new Date().getHours();
  const saludo = hour < 12 ? 'Buenos días' : hour < 18 ? 'Buenas tardes' : 'Buenas noches';

  let msg = `📊 *Dashboard del día — ${saludo}, ${firstName}*\n`;
  msg += `📅 ${workDate}\n\n`;

  // Attendance section
  msg += `👥 *ASISTENCIA* (${checkedIn.length}/${attendance.length})\n`;
  if (checkedIn.length > 0) {
    checkedIn.forEach(a => {
      const time = a.checkin_time ? new Date(a.checkin_time).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', hour12: false }) : '?';
      const outIcon = a.has_checked_out ? ' → 🏠' : '';
      msg += `  ✅ ${a.full_name.split(' ')[0]} (${a.shift_code}, ${time})${outIcon}\n`;
    });
  }
  if (notCheckedIn.length > 0) {
    notCheckedIn.forEach(a => {
      msg += `  ⏳ ${a.full_name.split(' ')[0]} (${a.shift_code}) — sin reportarse\n`;
    });
  }

  // Tasks section
  msg += `\n📋 *TAREAS* (${totalDone}/${totalTasks} completadas)\n`;
  if (totalInProgress > 0) msg += `  🔄 ${totalInProgress} en progreso\n`;
  if (totalPlanned > 0) msg += `  📋 ${totalPlanned} pendientes\n`;
  if (totalBlocked > 0) msg += `  🚫 ${totalBlocked} bloqueadas\n`;
  if (totalDone > 0) msg += `  ✅ ${totalDone} completadas\n`;

  // Progress bar
  const pct = totalTasks > 0 ? Math.round((totalDone / totalTasks) * 100) : 0;
  const filled = Math.round(pct / 10);
  const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
  msg += `\n  ${bar} ${pct}%\n`;

  // Per-employee breakdown
  if (taskSummary.length > 0) {
    msg += `\n👤 *POR EMPLEADO:*\n`;
    taskSummary.forEach(emp => {
      const done = parseInt(emp.done_count) || 0;
      const total = parseInt(emp.total_tasks) || 0;
      const blocked = parseInt(emp.blocked_count) || 0;
      const empPct = total > 0 ? Math.round((done / total) * 100) : 0;
      const blockedTag = blocked > 0 ? ` ⚠️${blocked} bloq.` : '';
      msg += `  • ${emp.full_name.split(' ')[0]}: ${done}/${total} (${empPct}%)${blockedTag}\n`;
    });
  }

  // Time tracking summary
  if (totalActualSecs > 0) {
    const totalH = Math.floor(totalActualSecs / 3600);
    const totalM = Math.floor((totalActualSecs % 3600) / 60);
    msg += `\n⏱️ *Tiempo total registrado:* ${totalH}h ${totalM}m\n`;
  }

  msg += `\nDi "asistencia", "avance del equipo", o "productividad" para más detalle.`;
  return msg;
}

async function handleManagerAttendance(employee, workDate) {
  const attendance = await checkinService.getTeamAttendanceReport(workDate);

  if (attendance.length === 0) {
    return '📋 No hay empleados asignados para hoy.';
  }

  const checkedIn = attendance.filter(a => a.has_checked_in);
  const notCheckedIn = attendance.filter(a => !a.has_checked_in);

  let msg = `👥 *Asistencia de hoy* (${workDate})\n\n`;

  if (checkedIn.length > 0) {
    msg += `✅ *Presentes (${checkedIn.length}):*\n`;
    checkedIn.forEach(a => {
      const inTime = a.checkin_time ? new Date(a.checkin_time).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', hour12: false }) : '?';
      const late = a.checkin_time && a.start_time && inTime > a.start_time.substring(0, 5) ? ' ⚠️ tarde' : '';
      let outInfo = '';
      if (a.has_checked_out && a.checkout_time) {
        const outTime = new Date(a.checkout_time).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', hour12: false });
        outInfo = ` → Salió: ${outTime}`;
      }
      msg += `  • ${a.full_name} — ${a.shift_code} (${a.start_time.substring(0, 5)}-${a.end_time.substring(0, 5)})\n    Entrada: ${inTime}${late}${outInfo}\n`;
    });
  }

  if (notCheckedIn.length > 0) {
    msg += `\n⏳ *Sin reportarse (${notCheckedIn.length}):*\n`;
    notCheckedIn.forEach(a => {
      msg += `  • ${a.full_name} — ${a.shift_code} (${a.start_time.substring(0, 5)}-${a.end_time.substring(0, 5)})\n`;
    });
  }

  msg += `\n📊 ${checkedIn.length} de ${attendance.length} empleados presentes.`;
  return msg;
}

async function handleManagerTasks(employee, workDate) {
  const taskSummary = await taskService.getTeamTaskSummary(workDate);

  if (taskSummary.length === 0) {
    return '📋 No hay tareas registradas para hoy.';
  }

  let msg = `📋 *Avance de tareas del equipo* (${workDate})\n\n`;

  for (const emp of taskSummary) {
    const done = parseInt(emp.done_count) || 0;
    const inProg = parseInt(emp.in_progress_count) || 0;
    const planned = parseInt(emp.planned_count) || 0;
    const blocked = parseInt(emp.blocked_count) || 0;
    const total = parseInt(emp.total_tasks) || 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const avgProg = emp.avg_progress ? `${emp.avg_progress}%` : '0%';

    msg += `👤 *${emp.full_name}*\n`;
    msg += `   Completadas: ${done}/${total} (${pct}%) — Avance prom: ${avgProg}\n`;
    if (inProg > 0) msg += `   🔄 ${inProg} en progreso\n`;
    if (planned > 0) msg += `   📋 ${planned} pendientes\n`;
    if (blocked > 0) msg += `   🚫 ${blocked} bloqueadas\n`;
    msg += '\n';
  }

  // Show individual blocked tasks if any
  const allTasks = [];
  for (const emp of taskSummary) {
    if (parseInt(emp.blocked_count) > 0) {
      const empTasks = await taskService.getTodayTasksForEmployee(emp.employee_id, workDate);
      const blockedTasks = empTasks.filter(t => t.status === 'blocked');
      blockedTasks.forEach(t => allTasks.push({ name: emp.full_name.split(' ')[0], task: t }));
    }
  }
  if (allTasks.length > 0) {
    msg += `⚠️ *Tareas bloqueadas:*\n`;
    allTasks.forEach(b => {
      msg += `  • ${b.name}: ${b.task.title}`;
      if (b.task.blocked_reason) msg += ` — _${b.task.blocked_reason}_`;
      msg += '\n';
    });
  }

  return msg;
}

async function handleManagerReport(employee, workDate) {
  const prodReport = await taskService.getTeamProductivityReport(workDate);

  if (prodReport.length === 0) {
    return '📊 No hay datos de productividad para hoy. Los empleados deben iniciar tareas para generar registros de tiempo.';
  }

  let msg = `⏱️ *Reporte de Productividad* (${workDate})\n\n`;

  let teamActualSecs = 0, teamStandardMins = 0, teamDone = 0, teamTotal = 0;
  const empRows = [];

  for (const emp of prodReport) {
    const actualSecs = (parseInt(emp.actual_seconds) || 0) + (parseInt(emp.current_open_seconds) || 0);
    const standardMinsDone = parseInt(emp.standard_minutes_done) || 0;
    const done = parseInt(emp.done_count) || 0;
    const total = parseInt(emp.total_tasks) || 0;
    const blocked = parseInt(emp.blocked_count) || 0;

    teamActualSecs += actualSecs;
    teamStandardMins += standardMinsDone;
    teamDone += done;
    teamTotal += total;

    empRows.push({ name: emp.full_name, actualSecs, standardMinsDone, done, total, blocked, employeeId: emp.employee_id });
  }

  // Team totals
  const teamActualH = Math.floor(teamActualSecs / 3600);
  const teamActualM = Math.floor((teamActualSecs % 3600) / 60);
  const teamStandardH = Math.floor(teamStandardMins / 60);
  const teamStandardM = teamStandardMins % 60;
  const teamEfficiency = teamActualSecs > 0 && teamStandardMins > 0
    ? Math.round((teamStandardMins * 60 / teamActualSecs) * 100) : 0;

  msg += `📈 *RESUMEN GENERAL*\n`;
  msg += `  Tareas completadas: ${teamDone}/${teamTotal}\n`;
  msg += `  Tiempo real: ${teamActualH}h ${teamActualM}m\n`;
  msg += `  Tiempo estándar: ${teamStandardH}h ${teamStandardM}m\n`;
  if (teamEfficiency > 0) {
    const effIcon = teamEfficiency >= 100 ? '🟢' : teamEfficiency >= 80 ? '🟡' : '🔴';
    msg += `  ${effIcon} Eficiencia: ${teamEfficiency}%\n`;
  }

  // Per-employee detail
  msg += `\n👤 *POR EMPLEADO:*\n`;
  for (const emp of empRows) {
    const actualH = Math.floor(emp.actualSecs / 3600);
    const actualM = Math.floor((emp.actualSecs % 3600) / 60);
    const stdH = Math.floor(emp.standardMinsDone / 60);
    const stdM = emp.standardMinsDone % 60;
    const efficiency = emp.actualSecs > 0 && emp.standardMinsDone > 0
      ? Math.round((emp.standardMinsDone * 60 / emp.actualSecs) * 100) : 0;

    msg += `\n*${emp.name.split(' ')[0]}*: ${emp.done}/${emp.total} tareas\n`;
    if (emp.actualSecs > 0) {
      msg += `  ⏱️ Real: ${actualH}h ${actualM}m`;
      if (emp.standardMinsDone > 0) {
        msg += ` / Estándar: ${stdH}h ${stdM}m`;
        const effIcon = efficiency >= 100 ? '🟢' : efficiency >= 80 ? '🟡' : '🔴';
        msg += ` ${effIcon}${efficiency}%`;
      } else {
        msg += ` _(sin tiempo estándar)_`;
      }
      msg += '\n';
    }
    if (emp.blocked > 0) msg += `  🚫 ${emp.blocked} bloqueadas\n`;

    // Per-task time detail for this employee
    const taskDetail = await taskService.getEmployeeTimeDetail(emp.employeeId, workDate);
    const tasksWithTime = taskDetail.filter(t => (parseInt(t.actual_seconds) || 0) > 0 || (parseInt(t.open_seconds) || 0) > 0);
    if (tasksWithTime.length > 0) {
      for (const t of tasksWithTime) {
        const tSecs = (parseInt(t.actual_seconds) || 0) + (parseInt(t.open_seconds) || 0);
        const tMins = Math.round(tSecs / 60);
        const stdMins = parseInt(t.standard_minutes) || 0;
        const statusIcon = t.status === 'done' ? '✅' : t.status === 'in_progress' ? '🔄' : t.status === 'blocked' ? '🚫' : '📋';
        let line = `    ${statusIcon} ${t.title}: ${tMins}min`;
        if (stdMins > 0) {
          const overTime = tMins > stdMins * 1.2;
          line += ` / ${stdMins}min est.`;
          if (overTime) line += ' ⚠️';
        }
        msg += line + '\n';
      }
    }
  }

  msg += `\n_Eficiencia = tiempo estándar ÷ tiempo real × 100_`;
  msg += `\n_🟢 ≥100% | 🟡 80-99% | 🔴 <80%_`;
  return msg;
}

// ─── Manager: Shift inquiry (drill-down: turnos → personas → tareas) ─────────

async function handleManagerShifts(employee, workDate, session) {
  const assignments = await shiftService.getTodayShiftAssignments(workDate);

  if (assignments.length === 0) {
    return 'No hay turnos asignados para hoy.';
  }

  // Group by shift_id
  const shiftMap = new Map();
  for (const a of assignments) {
    if (!shiftMap.has(a.shift_id)) {
      shiftMap.set(a.shift_id, {
        shiftId: a.shift_id,
        shiftCode: a.shift_code,
        startTime: a.start_time,
        endTime: a.end_time,
        employees: [],
      });
    }
    shiftMap.get(a.shift_id).employees.push({
      employeeId: a.employee_id,
      fullName: a.full_name,
    });
  }

  const shiftList = Array.from(shiftMap.values());
  let totalEmployees = 0;

  let msg = `🕐 *Turnos de hoy* (${workDate})\n\n`;
  shiftList.forEach((s, i) => {
    const startHH = s.startTime.substring(0, 5);
    const endHH = s.endTime.substring(0, 5);
    msg += `*${i + 1}.* ${s.shiftCode} (${startHH} - ${endHH}) — ${s.employees.length} empleado(s)\n`;
    totalEmployees += s.employees.length;
  });

  msg += `\n📊 Total: ${totalEmployees} empleados en ${shiftList.length} turno(s)`;
  msg += `\n\n¿De cuál turno quieres ver el detalle? (número o nombre)`;

  await updateSessionState(session.session_id, 'WAITING_SHIFT_PICK', {
    shiftOptions: shiftList,
  });

  return msg;
}

// ─── Session state handling (multi-turn conversations) ───────────────────────

async function handleSessionState(session, employee, text, messageId, workDate, shift) {
  const payload = session.state_payload || {};
  const cleaned = text.trim();

  // ── WAITING_LOCATION: cualquier texto (incluso "no", "cancelar") se interpreta
  // como negativa a compartir ubicacion. No dejamos que el cancel-guard lo intercepte
  // porque queremos registrar el check-in/out con status='not_shared' + escalonar.
  if (session.state === 'WAITING_LOCATION') {
    return await handleWaitingLocationText(session, employee, cleaned, workDate, shift);
  }

  // Check if user wants to cancel/reset
  // "no" solo cancela si es el mensaje completo (no "no, la 1 a la mitad")
  if (/^(cancelar|salir|nada|olvida)\b/i.test(cleaned) || /^no(\s+(gracias|quiero|ya|nada|mejor))?$/i.test(cleaned)) {
    await updateSessionState(session.session_id, 'IDLE', {});
    return { reply: 'Entendido, cancelado. ¿En qué más te puedo ayudar?', employee };
  }

  // If user sends a known NLP intent (not a yes/no response), break out of
  // the current state and let normal processing handle it
  const isSimpleResponse = /^(s[ií]|ok|va(?:le)?|dale|confirmo|afirmativo|claro|correcto|no)\b/i.test(cleaned);
  if (!isSimpleResponse) {
    const nlpCheck = nlpService.tryLocalNLP(cleaned);
    if (nlpCheck && nlpCheck.confidence >= 0.8) {
      // En WAITING_TASK_PICK, no salir del estado si el intent es coherente con la acción
      // (ej: "termine tareas 1 y 3" → TASK_DONE, pero ya estamos en contexto de completar)
      const isCoherentWithState = session.state === 'WAITING_TASK_PICK' &&
        ((payload.action === 'TASK_DONE' && nlpCheck.intent === 'TASK_DONE') ||
         (payload.action === 'TASK_PROGRESS' && nlpCheck.intent === 'TASK_PROGRESS'));
      if (!isCoherentWithState) {
        // User wants to do something else — reset state and let normal flow handle it
        await updateSessionState(session.session_id, 'IDLE', {});
        return null; // null = not handled, continue to normal processing
      }
    }
  }

  switch (session.state) {
    case 'WAITING_TASK_PICK': {
      const options = payload.taskOptions || [];

      // ─── "todas" / "todos" / "all" → complete/update ALL ────────────────
      if (/tod[ao]s/i.test(cleaned)) {
        if (payload.action === 'TASK_DONE') {
          let completedNames = [];
          for (const opt of options) {
            const fastBlocked = await requireNormalCompletion(employee.employee_id, opt.id, opt.title, session, payload.messageId);
            if (fastBlocked) return fastBlocked;
            await taskService.markTaskDone(opt.id, employee.employee_id, payload.messageId, null);
            completedNames.push(opt.title);
          }
          await updateSessionState(session.session_id, 'IDLE', {});
          let msg = `✅ *${completedNames.length} tareas completadas:*\n`;
          completedNames.forEach(name => msg += `• ${name}\n`);
          msg += '\n🎉 ¡Excelente trabajo! No tienes más tareas pendientes.';
          return { reply: msg, employee };
        }
        if (payload.action === 'TASK_PROGRESS') {
          const isRelative = !!payload.isRelative;
          let updatedNames = [];
          let lastEff = payload.percent;
          for (const opt of options) {
            // Verificar time log abierto para cada tarea
            const blocked = await requireTaskStarted(employee.employee_id, opt.id, opt.title, session);
            if (blocked) return blocked;
            const result = await taskService.updateTaskProgress(opt.id, payload.percent, employee.employee_id, payload.messageId, null, { isRelative });
            lastEff = result.effectivePercent || payload.percent;
            updatedNames.push(opt.title);
          }
          await updateSessionState(session.session_id, 'IDLE', {});
          const statusLabel = isRelative ? `+${payload.percent}%` : `a ${payload.percent}%`;
          let msg = `📊 *${updatedNames.length} tareas actualizadas ${statusLabel}:*\n`;
          updatedNames.forEach(name => msg += `• ${name}\n`);
          return { reply: msg, employee };
        }
      }

      // ─── Multiple numbers: "1, 2, 3" / "1 2 3" / "termine 1, 2, 3" ─────
      const multiNums = cleaned.match(/\d+/g);
      if (multiNums && multiNums.length > 1) {
        const nums = multiNums.map(n => parseInt(n)).filter(n => n >= 1 && n <= options.length);
        const uniqueNums = [...new Set(nums)];

        if (uniqueNums.length > 0) {
          const selectedTasks = uniqueNums.map(n => options[n - 1]);

          if (payload.action === 'TASK_DONE') {
            let completedNames = [];
            for (const task of selectedTasks) {
              const fastBlocked = await requireNormalCompletion(employee.employee_id, task.id, task.title, session, payload.messageId);
              if (fastBlocked) return fastBlocked;
              await taskService.markTaskDone(task.id, employee.employee_id, payload.messageId, null);
              completedNames.push(task.title);
            }
            const remaining = options.filter((_, i) => !uniqueNums.includes(i + 1));
            if (remaining.length > 0) {
              await updateSessionState(session.session_id, 'WAITING_TASK_PICK', {
                ...payload,
                taskOptions: remaining,
              });
              let msg = `✅ *${completedNames.length} tareas completadas:*\n`;
              completedNames.forEach(name => msg += `• ${name}\n`);
              msg += `\nQuedan ${remaining.length} pendiente(s):\n`;
              remaining.forEach((t, i) => msg += `*${i + 1}.* ${t.title}\n`);
              msg += '\n¿Alguna más? Número, "todas", o "cancelar".';
              return { reply: msg, employee };
            } else {
              await updateSessionState(session.session_id, 'IDLE', {});
              let msg = `✅ *${completedNames.length} tareas completadas:*\n`;
              completedNames.forEach(name => msg += `• ${name}\n`);
              msg += '\n🎉 ¡Excelente trabajo!';
              return { reply: msg, employee };
            }
          }

          if (payload.action === 'TASK_PROGRESS') {
            const isRelative = !!payload.isRelative;
            let updatedNames = [];
            for (const task of selectedTasks) {
              // Verificar time log abierto
              const blocked = await requireTaskStarted(employee.employee_id, task.id, task.title, session);
              if (blocked) return blocked;
              await taskService.updateTaskProgress(task.id, payload.percent, employee.employee_id, payload.messageId, null, { isRelative });
              updatedNames.push(task.title);
            }
            await updateSessionState(session.session_id, 'IDLE', {});
            const statusLabel = isRelative ? `+${payload.percent}%` : `a ${payload.percent}%`;
            let msg = `📊 *${updatedNames.length} tareas actualizadas ${statusLabel}:*\n`;
            updatedNames.forEach(name => msg += `• ${name}\n`);
            return { reply: msg, employee };
          }
        }
      }

      // ─── Single number → complete/update with session continuity ────────
      // Smart extraction: "1", "a la 1", "la 1", "el 2", "dije 1", "tarea 1"
      let num = parseInt(cleaned);
      if (!num || num < 1 || num > options.length) {
        // Try prefixed: "a la 1", "la 1", "el 2", "tarea 1"
        const prefixed = cleaned.match(/(?:(?:a\s+)?(?:la|el)|tarea|la\s+tarea|n[uú]mero|#)\s*(\d+)/i);
        if (prefixed) {
          const n = parseInt(prefixed[1]);
          if (n >= 1 && n <= options.length) num = n;
        }
        // Try any standalone number: "dije 1", "si la 1"
        if (!num || num < 1 || num > options.length) {
          const anyNum = cleaned.match(/\b(\d+)\b/);
          if (anyNum) {
            const n = parseInt(anyNum[1]);
            if (n >= 1 && n <= options.length) num = n;
          }
        }
      }
      if (num && num >= 1 && num <= options.length) {
        const selected = options[num - 1];

        if (payload.action === 'TASK_DONE') {
          // Backlog recurrente: pedir confirmación (solo daily/weekly/monthly, NO once/adhoc)
          if (selected.task_id) {
            const freq = await taskService.getTaskFrequency(selected.task_id);
            if (freq && freq !== 'once' && freq !== 'adhoc') {
              await updateSessionState(session.session_id, 'WAITING_BACKLOG_DONE_CONFIRM', {
                instanceId: selected.id,
                taskTitle: selected.title,
                messageId: payload.messageId,
              });
              return {
                reply: `📌 "*${selected.title}*" es una tarea de largo plazo. ¿Estás seguro de que ya se completó *definitivamente*?\n\nResponde *sí* para confirmar o *no* para cancelar.`,
                employee,
              };
            }
          }
          const fastBlocked = await requireNormalCompletion(employee.employee_id, selected.id, selected.title, session, payload.messageId);
          if (fastBlocked) return fastBlocked;
          await taskService.markTaskDone(selected.id, employee.employee_id, payload.messageId, null);
          const remaining = options.filter((_, i) => i !== num - 1);

          if (remaining.length > 0) {
            // Keep session active — re-number remaining tasks
            await updateSessionState(session.session_id, 'WAITING_TASK_PICK', {
              ...payload,
              taskOptions: remaining,
            });
            let msg = `✅ Tarea "*${selected.title}*" completada!\n\n`;
            msg += `Quedan ${remaining.length} pendiente(s):\n`;
            remaining.forEach((t, i) => msg += `*${i + 1}.* ${t.title}\n`);
            msg += '\n¿Alguna más? Número, "todas", o "cancelar".';
            return { reply: msg, employee };
          } else {
            await updateSessionState(session.session_id, 'IDLE', {});
            return { reply: `✅ Tarea "*${selected.title}*" completada!\n\n🎉 ¡Terminaste todas tus tareas!`, employee };
          }
        }

        if (payload.action === 'TASK_PROGRESS') {
          // Verificar time log abierto
          const blocked = await requireTaskStarted(employee.employee_id, selected.id, selected.title, session);
          if (blocked) return blocked;
          await updateSessionState(session.session_id, 'IDLE', {});
          const isRelative = !!payload.isRelative;
          const result = await taskService.updateTaskProgress(selected.id, payload.percent, employee.employee_id, payload.messageId, null, { isRelative });
          const eff = result.effectivePercent || payload.percent;
          const statusMsg = isRelative ? `+${payload.percent}% → Ahora vas en ${eff}%` : `Avance: ${eff}%`;
          return { reply: `📊 Tarea "*${selected.title}*" actualizada. ${statusMsg}`, employee };
        }
      }

      // ─── Try to match by task name (bidirectional) ────────────────────────
      for (const opt of options) {
        const optLower = opt.title.toLowerCase();
        const cleanedLower = cleaned.toLowerCase();
        if (optLower.includes(cleanedLower) || cleanedLower.includes(optLower)) {
          if (payload.action === 'TASK_DONE') {
            const fastBlocked = await requireNormalCompletion(employee.employee_id, opt.id, opt.title, session, payload.messageId);
            if (fastBlocked) return fastBlocked;
            await taskService.markTaskDone(opt.id, employee.employee_id, payload.messageId, null);
            const remaining = options.filter(o => o.id !== opt.id);
            if (remaining.length > 0) {
              await updateSessionState(session.session_id, 'WAITING_TASK_PICK', {
                ...payload,
                taskOptions: remaining,
              });
              let msg = `✅ Tarea "*${opt.title}*" completada!\n\n`;
              msg += `Quedan ${remaining.length} pendiente(s):\n`;
              remaining.forEach((t, i) => msg += `*${i + 1}.* ${t.title}\n`);
              msg += '\n¿Alguna más? Número, "todas", o "cancelar".';
              return { reply: msg, employee };
            } else {
              await updateSessionState(session.session_id, 'IDLE', {});
              return { reply: `✅ Tarea "*${opt.title}*" completada!\n\n🎉 ¡Terminaste todas tus tareas!`, employee };
            }
          }
          if (payload.action === 'TASK_PROGRESS') {
            // Verificar time log abierto
            const blocked = await requireTaskStarted(employee.employee_id, opt.id, opt.title, session);
            if (blocked) return blocked;
            await updateSessionState(session.session_id, 'IDLE', {});
            const isRelative = !!payload.isRelative;
            const result = await taskService.updateTaskProgress(opt.id, payload.percent, employee.employee_id, payload.messageId, null, { isRelative });
            const eff = result.effectivePercent || payload.percent;
            const statusMsg = isRelative ? `+${payload.percent}% → Ahora vas en ${eff}%` : `Avance: ${eff}%`;
            return { reply: `📊 Tarea "*${opt.title}*" actualizada. ${statusMsg}`, employee };
          }
        }
      }

      // ─── Progress detection: "la 1 a la mitad", "50%", "casi termino la 1" ──
      const progressPct = extractProgressFromText(cleaned);
      if (progressPct !== null) {
        // Find which task — try number reference in context
        let targetTask = null;
        const pickNumMatch = cleaned.match(/(?:la|el|tarea|#)\s*(\d+)/i);
        if (pickNumMatch) {
          const tn = parseInt(pickNumMatch[1]);
          if (tn >= 1 && tn <= options.length) targetTask = options[tn - 1];
        }

        // Try name match (at least 2 words of 4+ chars match)
        if (!targetTask) {
          for (const opt of options) {
            const words = opt.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
            const matchCount = words.filter(w => cleaned.toLowerCase().includes(w)).length;
            if (matchCount >= 2 || (words.length <= 2 && matchCount >= 1)) {
              targetTask = opt;
              break;
            }
          }
        }

        // If only one option left, use it
        if (!targetTask && options.length === 1) {
          targetTask = options[0];
        }

        if (targetTask) {
          // Verificar time log abierto
          const blocked = await requireTaskStarted(employee.employee_id, targetTask.id, targetTask.title, session);
          if (blocked) return blocked;
          const result = await taskService.updateTaskProgress(targetTask.id, progressPct, employee.employee_id, messageId, null);
          const eff = result.effectivePercent || progressPct;

          if (eff >= 100) {
            // 100% = done
            const remaining = options.filter(o => o.id !== targetTask.id);
            if (remaining.length > 0) {
              await updateSessionState(session.session_id, 'WAITING_TASK_PICK', {
                action: 'TASK_DONE',
                taskOptions: remaining,
                messageId: payload.messageId,
              });
              let msg = `✅ Tarea "*${targetTask.title}*" completada!\n\n`;
              msg += `Quedan ${remaining.length} pendiente(s):\n`;
              remaining.forEach((t, i) => msg += `*${i + 1}.* ${t.title}\n`);
              msg += '\n¿Alguna más? Número, "todas", o "cancelar".';
              return { reply: msg, employee };
            } else {
              await updateSessionState(session.session_id, 'IDLE', {});
              return { reply: `✅ Tarea "*${targetTask.title}*" completada!\n\n🎉 ¡Terminaste todas tus tareas!`, employee };
            }
          }

          // Keep session active for more operations
          let msg = `📊 Tarea "*${targetTask.title}*" actualizada a ${eff}%.\n\n`;
          msg += `Tareas pendientes:\n`;
          options.forEach((t, i) => {
            const pctLabel = t.id === targetTask.id ? ` (${eff}%)` : '';
            msg += `*${i + 1}.* ${t.title}${pctLabel}\n`;
          });
          msg += '\n¿Completaste alguna? Número, "todas", o "cancelar".';
          await updateSessionState(session.session_id, 'WAITING_TASK_PICK', {
            action: 'TASK_DONE',
            taskOptions: options,
            messageId: payload.messageId,
          });
          return { reply: msg, employee };
        }
      }

      // ─── "termine/terminar/listo" ambiguo sin número → re-mostrar la lista ──
      // Evita el silent-reply cuando el usuario repite "termine" dentro del picker
      // sin haber dado una referencia concreta. Nos quedamos en el mismo estado
      // y le mostramos las opciones otra vez.
      if (/(ya\s+)?termin(?:[eéo]|ar|a|ado|ada)\b|^listo$|^hecho$|^completado$|acab(?:[eéo]|ar|a|ado|ada)\b|finalic[eé]|finaliza(?:r|do|da)?\b/i.test(cleaned)) {
        const plural = options.length > 1 ? 's' : '';
        let msg = `¿Cuál tarea completaste? Responde con el *número*, varios números (ej: 1,2,3), o "todas":\n\n`;
        options.forEach((t, i) => msg += `*${i + 1}.* ${t.title}\n`);
        msg += `\n(${options.length} tarea${plural} en la lista)`;
        // Mantener el mismo estado, no reset
        return { reply: msg, employee };
      }

      // ─── Nothing matched → reset to IDLE and fall through to normal NLP ──
      await updateSessionState(session.session_id, 'IDLE', {});
      return null;
    }

    case 'WAITING_PLAN': {
      // User is providing task title after "voy a hacer" (no title given initially)
      if (payload.action === 'TASK_CREATE' && cleaned.length > 2) {
        // ── "Tarea 1", "tarea 3", etc. → interpretar como referencia a tarea existente, NO crear nueva ──
        const tareaNumMatch = cleaned.match(/^tarea\s+(\d+)$/i);
        if (tareaNumMatch) {
          const existingTasks = await taskService.getTodayTasksForEmployee(employee.employee_id, workDate, shift?.shift_id);
          const idx = parseInt(tareaNumMatch[1]) - 1;
          if (idx >= 0 && idx < existingTasks.length) {
            const refTask = existingTasks[idx];
            await updateSessionState(session.session_id, 'IDLE', {});
            if (refTask.status === 'done') {
              await updateSessionState(session.session_id, 'WAITING_RESTART_CONFIRM', {
                instanceId: refTask.instance_id,
                taskTitle: refTask.title,
              });
              return {
                reply: `⚠️ La tarea "*${refTask.title}*" ya está *completada*.\n\n¿Quieres reiniciarla? Responde *sí* o *no*.`,
                employee,
              };
            }
            if (refTask.status !== 'canceled') {
              const wasBlocked = refTask.status === 'blocked';
              if (refTask.status === 'planned' || refTask.status === 'blocked') {
                await taskService.startTask(refTask.instance_id, employee.employee_id);
              }
              if (wasBlocked) await notifyBlockerResolved(employee, workDate, refTask.title);
              const rply = await appendChecklistLink(refTask.instance_id, employee.employee_id,
                `🔄 Iniciaste la tarea "*${refTask.title}*". Avísame cuando avances o termines.`);
              return { reply: rply, employee };
            }
          }
        }

        // Move to confirmation step instead of creating immediately
        await updateSessionState(session.session_id, 'WAITING_ADHOC_CONFIRM', {
          title: cleaned,
          shiftId: shift?.shift_id || null,
          description: null,
          pendingPhotos: [],
        });
        return {
          reply: `📋 ¿Confirmas nueva tarea: "*${cleaned}*"?\nPuedes agregar detalles, enviar fotos, o responde *sí* para iniciar.`,
          employee,
        };
      }
      return { reply: 'Dime el nombre de la tarea que vas a hacer.', employee };
    }

    case 'WAITING_WRAPUP': {
      if (payload.action === 'TASK_BLOCKED' && cleaned.length > 2) {
        await updateSessionState(session.session_id, 'IDLE', {});
        await taskService.markTaskBlocked(payload.instanceId, employee.employee_id, payload.messageId, cleaned);

        const task = await query(`SELECT title FROM task_instances WHERE instance_id = $1`, [payload.instanceId]);
        const taskTitle = task.rows[0]?.title || 'Tarea';
        const notifMsg = `⚠️ *Bloqueo reportado*\nEmpleado: ${employee.full_name}\nTarea: ${taskTitle}\nMotivo: ${cleaned}`;
        const escalation = await escalateToSupervisor(employee, workDate, 'BLOCKER_REPORTED', notifMsg, null);

        let reply = `⚠️ Bloqueo registrado: "${cleaned}"`;
        if (escalation.notified) {
          reply += '\n✅ Se notificó a tu supervisor.';
        } else {
          reply += `\n⚠️ No se pudo notificar a tu supervisor (${escalation.reason}). Avísale directamente.`;
        }
        return { reply, employee };
      }
      return { reply: 'Describe brevemente qué te está bloqueando.', employee };
    }

    case 'WAITING_START_BEFORE_PROGRESS': {
      // ── El usuario reportó avance sin haber iniciado la tarea ──────────
      // payload: { instanceId, taskTitle }
      const isConfirm = /^(s[ií]|ok|va(?:le)?|dale|confirmo|afirmativo|claro|correcto)(?=\s|$|[,.])/i.test(cleaned);
      const isCancel = /^(no|cancelar|mejor\s+no|nada|olvida)/i.test(cleaned);

      if (isConfirm) {
        await taskService.startTask(payload.instanceId, employee.employee_id);
        await updateSessionState(session.session_id, 'IDLE', {});
        const rplySBP = await appendChecklistLink(payload.instanceId, employee.employee_id,
          `▶️ Tarea "*${payload.taskTitle}*" iniciada. Ahora puedes reportar tu avance.`);
        return {
          reply: rplySBP,
          employee,
          instanceId: payload.instanceId,
        };
      }
      if (isCancel) {
        await updateSessionState(session.session_id, 'IDLE', {});
        return {
          reply: `👌 Entendido. Cuando vayas a trabajar en "*${payload.taskTitle}*", dime "empiezo con ${payload.taskTitle}" para registrar el inicio.`,
          employee,
        };
      }
      return {
        reply: `⏱️ ¿Quieres iniciar "*${payload.taskTitle}*" ahora para registrar tu tiempo?\n\nResponde *sí* o *no*.`,
        employee,
      };
    }

    case 'WAITING_FAST_DONE_CONFIRM': {
      // ── Confirmación: tarea completada sospechosamente rápido ──────────
      // payload: { instanceId, taskTitle, elapsedMinutes, standardMinutes, messageId,
      //            nextStartInstanceId?, nextStartTitle? }
      const isConfirm = /^(s[ií]|ok|va(?:le)?|dale|confirmo|afirmativo|claro|correcto)(?=\s|$|[,.])/i.test(cleaned);
      const isCancel = /^(no|cancelar|mejor\s+no|nada|olvida)/i.test(cleaned);

      if (isConfirm) {
        // Completar la tarea
        await taskService.markTaskDone(payload.instanceId, employee.employee_id, payload.messageId, null);
        // Escalar al supervisor
        const notifMsg = `⚡ *Tarea completada rápidamente*\nEmpleado: ${employee.full_name}\nTarea: ${payload.taskTitle}\nTiempo real: ${payload.elapsedMinutes} min (estimado: ${payload.standardMinutes} min)`;
        await escalateToSupervisor(employee, workDate, 'FAST_COMPLETION', notifMsg, null);
        await updateSessionState(session.session_id, 'IDLE', {});
        let reply = `✅ Tarea "*${payload.taskTitle}*" completada. Se notificó a tu supervisor sobre el tiempo.`;
        // Si hay tarea siguiente (compound done+start)
        if (payload.nextStartInstanceId) {
          await taskService.startTask(payload.nextStartInstanceId, employee.employee_id);
          reply = await appendChecklistLink(payload.nextStartInstanceId, employee.employee_id,
            reply + `\n🔄 Iniciaste "*${payload.nextStartTitle}*".`);
        }
        return { reply, employee, instanceId: payload.nextStartInstanceId || payload.instanceId };
      }
      if (isCancel) {
        await updateSessionState(session.session_id, 'IDLE', {});
        return {
          reply: `👌 Entendido, "*${payload.taskTitle}*" sigue en progreso. Avísame cuando realmente termines.`,
          employee,
        };
      }
      return {
        reply: `⚡ Completaste "*${payload.taskTitle}*" en ${payload.elapsedMinutes} min (estimado: ${payload.standardMinutes} min).\n\n¿Confirmas que ya terminaste? Responde *sí* o *no*.`,
        employee,
      };
    }

    case 'WAITING_RESTART_CONFIRM': {
      // ── Confirmación para reiniciar tarea ya completada ──────────────
      // payload: { instanceId, taskTitle }
      const isConfirm = /^(s[ií]|ok|va(?:le)?|dale|confirmo|afirmativo|claro|correcto)(?=\s|$|[,.])/i.test(cleaned);
      const isCancel = /^(no|cancelar|mejor\s+no|nada|olvida)/i.test(cleaned);

      if (isConfirm) {
        await taskService.restartTask(payload.instanceId, employee.employee_id);
        await updateSessionState(session.session_id, 'IDLE', {});
        const rplyRestart = await appendChecklistLink(payload.instanceId, employee.employee_id,
          `🔄 Reiniciaste la tarea "*${payload.taskTitle}*". Avísame cuando avances o termines.`);
        return {
          reply: rplyRestart,
          employee, instanceId: payload.instanceId,
        };
      }
      if (isCancel) {
        await updateSessionState(session.session_id, 'IDLE', {});
        return {
          reply: `👌 Entendido, la tarea "*${payload.taskTitle}*" sigue como completada.`,
          employee,
        };
      }
      return {
        reply: `⚠️ La tarea "*${payload.taskTitle}*" ya está completada.\n\n¿Quieres reiniciarla? Responde *sí* o *no*.`,
        employee,
      };
    }

    case 'WAITING_SWITCH_CONFIRM': {
      // ── Qué hacer con la(s) tarea(s) en progreso cuando el empleado quiere iniciar otra ──
      // payload: { pendingStartId, pendingStartTitle, currentInProgress: [{id, title, pct}], messageId }
      const inProg = payload.currentInProgress || [];
      const plural = inProg.length > 1 ? 's' : '';

      // Cancelar
      if (/^(no|cancelar|mejor\s+no|nada|olvida)\b/i.test(cleaned)) {
        await updateSessionState(session.session_id, 'IDLE', {});
        return {
          reply: `👌 Entendido, sigo trabajando en la${plural} tarea${plural} actual${plural}. No inicié "*${payload.pendingStartTitle}*".`,
          employee,
        };
      }

      // Simultáneo → iniciar la nueva dejando las anteriores en progreso
      if (/simult[aá]neo|paralelo|ambas|las\s+dos|al\s+mismo\s+tiempo|a\s+la\s+vez/i.test(cleaned)) {
        await taskService.startTask(payload.pendingStartId, employee.employee_id);
        await updateSessionState(session.session_id, 'IDLE', {});
        const rplySim = await appendChecklistLink(payload.pendingStartId, employee.employee_id,
          `🔄 Iniciaste "*${payload.pendingStartTitle}*" en paralelo. Ahora tienes ${inProg.length + 1} tareas en progreso.`);
        return { reply: rplySim, employee, instanceId: payload.pendingStartId };
      }

      // Pausar las actuales → marcarlas como 'planned' de nuevo (pausa == no en progreso)
      if (/^pausar?\b|^pausa\b/i.test(cleaned)) {
        let pausedNames = [];
        for (const t of inProg) {
          try {
            // Revertir a 'planned' sin borrar progress_percent acumulado
            await query(
              `UPDATE task_instances
                 SET status = 'planned', updated_at = NOW()
               WHERE instance_id = $1 AND employee_id = $2 AND status = 'in_progress'`,
              [t.id, employee.employee_id]
            );
            // Cerrar time log abierto
            try { await taskService.stopTimeLog(t.id, employee.employee_id); } catch (_) { /* noop */ }
            pausedNames.push(t.title);
          } catch (err) {
            logger.warn('Failed to pause task during switch', { err: err.message, instanceId: t.id });
          }
        }
        await taskService.startTask(payload.pendingStartId, employee.employee_id);
        await updateSessionState(session.session_id, 'IDLE', {});
        let msg = '';
        if (pausedNames.length > 0) {
          msg += `⏸ Pausé ${pausedNames.length} tarea${plural}:\n`;
          pausedNames.forEach(n => msg += `• ${n}\n`);
          msg += '\n';
        }
        const rplyPause = await appendChecklistLink(payload.pendingStartId, employee.employee_id,
          msg + `🔄 Iniciaste "*${payload.pendingStartTitle}*". Avísame cuando avances o termines.`);
        return { reply: rplyPause, employee, instanceId: payload.pendingStartId };
      }

      // "terminar N" / "termine la 1" / "hecha la 2" → marcar como done la N y arrancar la nueva
      const termMatch = cleaned.match(/(?:termin|acab|finaliz|hech|list|marca)\w*\s+(?:la\s+|el\s+|tarea\s+|#)?(\d+)/i);
      if (termMatch) {
        const n = parseInt(termMatch[1]);
        if (n >= 1 && n <= inProg.length) {
          const selected = inProg[n - 1];
          // Backlog recurrente: no auto-completar sin confirmación
          const fastBlocked = await requireNormalCompletion(employee.employee_id, selected.id, selected.title, session, payload.messageId);
          if (fastBlocked) return fastBlocked;
          await taskService.markTaskDone(selected.id, employee.employee_id, payload.messageId, null);
          await taskService.startTask(payload.pendingStartId, employee.employee_id);
          await updateSessionState(session.session_id, 'IDLE', {});
          const rplyDoneStart = await appendChecklistLink(payload.pendingStartId, employee.employee_id,
            `✅ "*${selected.title}*" completada.\n🔄 Iniciaste "*${payload.pendingStartTitle}*".`);
          return { reply: rplyDoneStart, employee, instanceId: payload.pendingStartId };
        }
      }

      // Respuesta no reconocida → repetir opciones
      const list = inProg
        .map((t, i) => `*${i + 1}.* ${t.title} (${t.pct || 0}%)`)
        .join('\n');
      return {
        reply: `No entendí. Tienes ${inProg.length} tarea${plural} en progreso:\n${list}\n\n¿Qué hago con "*${payload.pendingStartTitle}*"?\n• *pausar*\n• *terminar N*\n• *simultáneo*\n• *cancelar*`,
        employee,
      };
    }

    case 'WAITING_START_BEFORE_DONE': {
      // ── Tarea nunca iniciada que el empleado quiere marcar como completada ──
      // payload: { instanceId, taskTitle, messageId, nextStartInstanceId?, nextStartTitle? }
      const isConfirm = /^(s[ií]|ok|va(?:le)?|dale|confirmo|afirmativo|claro|correcto)(?=\s|$|[,.])/i.test(cleaned);
      const isCancel = /^(no|cancelar|mejor\s+no|nada|olvida)/i.test(cleaned);

      if (isConfirm) {
        // Iniciar + completar inmediatamente (sin fast-check ya que no hay datos de tiempo)
        await taskService.startTask(payload.instanceId, employee.employee_id);
        await taskService.markTaskDone(payload.instanceId, employee.employee_id, payload.messageId, null);
        // Notificar al supervisor sobre tarea sin registro de inicio
        const notifMsg = `⚠️ *Tarea completada sin registro de inicio*\nEmpleado: ${employee.full_name}\nTarea: ${payload.taskTitle}\nSe completó sin haber reportado el inicio.`;
        await escalateToSupervisor(employee, workDate, 'NO_TIME_LOG', notifMsg, null);
        await updateSessionState(session.session_id, 'IDLE', {});
        let reply = `✅ Tarea "*${payload.taskTitle}*" completada.\n⚠️ Recuerda reportar el inicio de tus tareas ("empiezo con...") para un mejor control de tiempos.`;
        // Si hay compound done+start
        if (payload.nextStartInstanceId) {
          await taskService.startTask(payload.nextStartInstanceId, employee.employee_id);
          reply = await appendChecklistLink(payload.nextStartInstanceId, employee.employee_id,
            reply + `\n🔄 Iniciaste "*${payload.nextStartTitle}*".`);
        }
        return { reply, employee, instanceId: payload.nextStartInstanceId || payload.instanceId };
      }
      if (isCancel) {
        // Solo iniciar la tarea, no completarla
        await taskService.startTask(payload.instanceId, employee.employee_id);
        await updateSessionState(session.session_id, 'IDLE', {});
        const rplySBD = await appendChecklistLink(payload.instanceId, employee.employee_id,
          `▶️ Tarea "*${payload.taskTitle}*" iniciada. Avísame cuando avances o termines.`);
        return {
          reply: rplySBD,
          employee, instanceId: payload.instanceId,
        };
      }
      return {
        reply: `⏱️ La tarea "*${payload.taskTitle}*" no fue reportada como iniciada.\n\nResponde *sí* para completarla de todos modos o *no* para iniciarla primero.`,
        employee,
      };
    }

    case 'WAITING_BACKLOG_DONE_CONFIRM': {
      // ── Confirmación para completar tarea de largo plazo (backlog 📌) ──
      const isConfirm = /^(s[ií]|ok|va(?:le)?|dale|confirmo|afirmativo|claro|correcto)(?=\s|$|[,.])/i.test(cleaned);
      const isCancel = /^(no|cancelar|mejor\s+no|nada|olvida)/i.test(cleaned);

      if (isConfirm) {
        await taskService.markTaskDone(payload.instanceId, employee.employee_id, payload.messageId, null);
        await updateSessionState(session.session_id, 'IDLE', {});
        return {
          reply: `✅ Tarea de largo plazo "*${payload.taskTitle}*" marcada como completada definitivamente.`,
          employee,
        };
      }
      if (isCancel) {
        await updateSessionState(session.session_id, 'IDLE', {});
        return {
          reply: `👌 Entendido, "*${payload.taskTitle}*" sigue activa. Puedes reportar avance con un porcentaje.`,
          employee,
        };
      }
      // Respuesta no reconocida → repetir pregunta
      return {
        reply: `📌 "*${payload.taskTitle}*" es una tarea de largo plazo. ¿Confirmas que ya se completó *definitivamente*?\n\nResponde *sí* o *no*.`,
        employee,
      };
    }

    case 'WAITING_POST_CHECKOUT_CONFIRM': {
      // ── El empleado ya hizo checkout e intentó una acción de tarea ──────
      // payload: { originalText, messageId }
      const isConfirm = /^(s[ií]|ok|va(?:le)?|dale|confirmo|afirmativo|claro|correcto)(?=\s|$|[,.])/i.test(cleaned);
      const isCancel = /^(no|cancelar|mejor\s+no|nada|olvida)/i.test(cleaned);

      if (isConfirm) {
        const savedText = payload.originalText;
        await updateSessionState(session.session_id, 'IDLE', {});
        // Notificar al supervisor sobre acción post-checkout
        await escalateToSupervisor(employee, workDate, 'POST_CHECKOUT_ACTION',
          `⚠️ *Acción post-checkout*\nEmpleado: ${employee.full_name}\nMensaje: "${savedText}"\nEl empleado realizó una acción después de registrar su salida.`,
          null);
        // Devolver el texto original para que processInboundMessage lo re-procese
        return { _reprocessText: savedText };
      }
      if (isCancel) {
        await updateSessionState(session.session_id, 'IDLE', {});
        return { reply: '👍 OK, no se realizó ninguna acción. ¡Que descanses! 🌙', employee };
      }
      return {
        reply: `⚠️ Ya registraste tu salida. ¿Confirmas que quieres realizar esta acción?\n\nResponde *sí* o *no*.`,
        employee,
      };
    }

    case 'WAITING_ADHOC_CONFIRM': {
      // ── Confirmation flow for ad-hoc tasks ─────────────────────────────
      // payload: { title, shiftId, description, pendingPhotos: [uuid...], estimateMinutes: number|null }

      // Note: (?=\s|$|[,.]) instead of \b because \b fails with accented chars like í
      const isConfirm = /^(s[ií]|ok|va(?:le)?|dale|confirmo|listo|correcto|afirmativo|claro)(?=\s|$|[,.])/i.test(cleaned);

      if (isConfirm) {
        // ── Create the task ──────────────────────────────────────────────
        // If confirm message has extra text after "sí", treat as description
        // e.g. "sí, es en el cuarto 201" or "sí, como 45 minutos"
        let desc = payload.description || null;
        const extraText = cleaned.replace(/^(s[ií]|ok|va|dale|confirmo|listo|correcto|afirmativo|claro)[,.\s]*/i, '').trim();
        if (extraText.length > 2) {
          desc = desc ? `${desc}. ${extraText}` : extraText;
        }

        // Check for time estimate in confirm message ("sí, como 45 min")
        const confirmEstimate = extraText.length > 0 ? extractTimeEstimate(extraText) : null;
        const finalEstimate = confirmEstimate || payload.estimateMinutes || null;

        const instance = await taskService.createAdHocTask(
          employee.employee_id,
          workDate,
          payload.title,
          desc,
          payload.shiftId,
          finalEstimate  // null → createAdHocTask usará default 30
        );

        // Link pending photos to the new task instance
        const photoCount = (payload.pendingPhotos || []).length;
        if (photoCount > 0) {
          await attachmentService.linkAttachmentsToInstance(payload.pendingPhotos, instance.instance_id);
        }

        let reply = `📝 Tarea creada: "*${payload.title}*"\n`;
        if (desc) reply += `📄 Detalle: ${desc}\n`;
        if (photoCount > 0) reply += `📸 ${photoCount} foto${photoCount > 1 ? 's' : ''} adjunta${photoCount > 1 ? 's' : ''}\n`;

        // If we already have an estimate, confirm it and go IDLE
        if (finalEstimate) {
          reply += `⏱️ Tiempo estimado: ${finalEstimate} min\n`;
          reply += `Estado: *En progreso*. Avísame cuando avances o termines.`;
          await updateSessionState(session.session_id, 'IDLE', {});
          return { reply, employee };
        }

        // No estimate yet → ask and wait for answer
        reply += `Estado: *En progreso*.\n\n⏱️ ¿Cuánto tiempo estimas? (ej: 30 min, 1 hora)\nSi no sabes, responde *no sé*.`;
        await updateSessionState(session.session_id, 'WAITING_ADHOC_ESTIMATE', {
          instanceId: instance.instance_id,
          title: payload.title,
        });

        return { reply, employee };
      }

      // ── Not a confirmation → treat as additional description ───────────
      // e.g. "es en el cuarto 201" or "hay que cambiar el cable también"
      // Also check for time estimate in description text
      const descEstimate = extractTimeEstimate(cleaned);
      const updatedDesc = payload.description
        ? `${payload.description}. ${cleaned}`
        : cleaned;

      await updateSessionState(session.session_id, 'WAITING_ADHOC_CONFIRM', {
        ...payload,
        description: updatedDesc,
        estimateMinutes: descEstimate || payload.estimateMinutes,
      });

      const photoNote = (payload.pendingPhotos || []).length > 0
        ? `\n📸 ${payload.pendingPhotos.length} foto(s) adjunta(s).`
        : '';
      const estNote = (descEstimate || payload.estimateMinutes)
        ? `\n⏱️ Estimado: ${descEstimate || payload.estimateMinutes} min`
        : '';

      return {
        reply: `📄 Detalle agregado.\n📋 Tarea: "*${payload.title}*"\n📝 Info: ${updatedDesc}${estNote}${photoNote}\n\nResponde *sí* para confirmar o sigue agregando detalles.`,
        employee,
      };
    }

    case 'WAITING_ADHOC_ESTIMATE': {
      // ── Time estimate for ad-hoc task ─────────────────────────────────
      // payload: { instanceId, title }
      // Normalizar números en letras → dígitos (Whisper transcribe "cuarenta" no "40")
      const normalizedEstimate = nlpService.normalizeSpanishNumbers(cleaned);
      const estimate = extractTimeEstimate(normalizedEstimate);

      // "no sé", "ni idea", "no tengo idea", "paso" → keep default 30
      const isSkip = /^(no\s+s[eé]|ni\s+idea|no\s+tengo\s+idea|paso|ninguno|nada)(?=\s|$|[,.])/i.test(cleaned);

      // Si solo dijo un número sin "minutos" (ej: "40", "unos 40"), asumirlo como minutos
      const bareNumber = !estimate && normalizedEstimate.match(/(\d+)/);
      const finalEstimate = estimate || (bareNumber ? Math.max(1, Math.min(parseInt(bareNumber[1]), 480)) : null);

      if (finalEstimate) {
        await taskService.updateStandardMinutes(payload.instanceId, finalEstimate);
        await updateSessionState(session.session_id, 'IDLE', {});
        return {
          reply: `⏱️ Estimado de *${finalEstimate} min* registrado para "*${payload.title}*". ¡Avísame cuando avances o termines!`,
          employee,
        };
      }

      if (isSkip) {
        await updateSessionState(session.session_id, 'IDLE', {});
        return {
          reply: `👍 OK, se dejó el estimado por defecto (30 min). Avísame cuando avances o termines.`,
          employee,
        };
      }

      // Unrecognized → go IDLE and fall through to normal processing
      await updateSessionState(session.session_id, 'IDLE', {});
      return null; // Fall through to normal processing
    }

    // ─── Supervisor shift inquiry: pick a shift ─────────────────────────
    case 'WAITING_SHIFT_PICK': {
      const shiftOptions = payload.shiftOptions || [];

      // Try to match by number ("1", "el 1", "de 1", "turno 1")
      let selected = null;
      const shiftNumMatch = cleaned.match(/(\d+)/);
      const num = shiftNumMatch ? parseInt(shiftNumMatch[1]) : NaN;
      if (num >= 1 && num <= shiftOptions.length) {
        selected = shiftOptions[num - 1];
      }

      // Try to match by shift code name ("turno A", "A", "mañana")
      if (!selected) {
        const lower = cleaned.toLowerCase();
        for (const opt of shiftOptions) {
          const code = opt.shiftCode.toLowerCase();
          if (lower.includes(code) || code.includes(lower)) {
            selected = opt;
            break;
          }
        }
      }

      if (!selected) {
        // Unrecognized → reset to IDLE, fall through to normal NLP
        await updateSessionState(session.session_id, 'IDLE', {});
        return null;
      }

      // Get attendance data to show check-in status for employees in this shift
      const attendance = await checkinService.getTeamAttendanceReport(workDate);
      const attendanceMap = new Map();
      for (const a of attendance) {
        attendanceMap.set(a.employee_id, a);
      }

      const startHH = selected.startTime.substring(0, 5);
      const endHH = selected.endTime.substring(0, 5);
      let checkedInCount = 0;

      let msg = `👥 *${selected.shiftCode}* (${startHH} - ${endHH}) — ${selected.employees.length} empleado(s)\n\n`;

      selected.employees.forEach((emp, i) => {
        const att = attendanceMap.get(emp.employeeId);
        let statusIcon = '⏳';
        let statusText = 'sin reportar';

        if (att && att.has_checked_in) {
          checkedInCount++;
          const inTime = att.checkin_time
            ? new Date(att.checkin_time).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', hour12: false })
            : '?';
          const late = att.checkin_time && selected.startTime && inTime > startHH ? ' ⚠️ tarde' : '';
          statusIcon = '✅';
          statusText = `reportado ${inTime}${late}`;

          if (att.has_checked_out) {
            const outTime = att.checkout_time
              ? new Date(att.checkout_time).toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', hour12: false })
              : '?';
            statusText += ` → salió ${outTime}`;
          }
        }

        msg += `*${i + 1}.* ${emp.fullName} ${statusIcon} ${statusText}\n`;
      });

      msg += `\n📊 Presentes: ${checkedInCount}/${selected.employees.length}`;
      msg += `\n\n¿Ver tareas de alguien? (número) o "plantillas" para ver las tareas del turno.`;

      await updateSessionState(session.session_id, 'WAITING_SHIFT_EMPLOYEE_PICK', {
        shiftId: selected.shiftId,
        shiftCode: selected.shiftCode,
        startTime: selected.startTime,
        endTime: selected.endTime,
        employeeOptions: selected.employees,
      });

      return { reply: msg, employee };
    }

    // ─── Supervisor shift inquiry: pick an employee or view templates ──
    case 'WAITING_SHIFT_EMPLOYEE_PICK': {
      const empOptions = payload.employeeOptions || [];
      const lower = cleaned.toLowerCase();

      // "plantillas" / "tareas del turno" / "tareas" → show shift task templates
      if (/plantilla|tareas?\s+del\s+turno|^tareas$/i.test(lower)) {
        const templates = await shiftService.getShiftTaskTemplates(payload.shiftId);
        await updateSessionState(session.session_id, 'IDLE', {});

        if (templates.length === 0) {
          return { reply: `📋 El turno *${payload.shiftCode}* no tiene plantillas de tareas configuradas.`, employee };
        }

        let totalMins = 0;
        let msg = `📋 *Plantillas del ${payload.shiftCode}*\n\n`;
        templates.forEach((t, i) => {
          const mins = t.standard_minutes || t.default_minutes || 0;
          totalMins += mins;
          msg += `*${i + 1}.* ${t.title}`;
          if (mins > 0) msg += ` — ${mins} min`;
          msg += '\n';
        });
        msg += `\nTotal: ${templates.length} tareas`;
        if (totalMins > 0) {
          const h = Math.floor(totalMins / 60);
          const m = totalMins % 60;
          msg += `, ${h > 0 ? h + 'h ' : ''}${m}min estándar`;
        }
        return { reply: msg, employee };
      }

      // Try to match employee by number
      // "1", "de 1", "el 1", "tareas de 1", "ver 1" → extraer número
      let selectedEmp = null;
      const empNumMatch = cleaned.match(/(\d+)/);
      const empNum = empNumMatch ? parseInt(empNumMatch[1]) : NaN;
      if (empNum >= 1 && empNum <= empOptions.length) {
        selectedEmp = empOptions[empNum - 1];
      }

      // Try to match by name
      if (!selectedEmp) {
        for (const opt of empOptions) {
          const nameLower = opt.fullName.toLowerCase();
          if (nameLower.includes(lower) || lower.includes(nameLower.split(' ')[0])) {
            selectedEmp = opt;
            break;
          }
        }
      }

      if (!selectedEmp) {
        await updateSessionState(session.session_id, 'IDLE', {});
        return null; // Fall through to normal NLP
      }

      // Show tasks for the selected employee (filtered by the selected shift)
      const empTasks = await taskService.getTodayTasksForEmployee(selectedEmp.employeeId, workDate, payload.shiftId);
      await updateSessionState(session.session_id, 'IDLE', {});

      const firstName = selectedEmp.fullName.split(' ')[0];
      if (empTasks.length === 0) {
        return { reply: `📋 *${selectedEmp.fullName}* no tiene tareas asignadas hoy en el turno *${payload.shiftCode}*.`, employee };
      }

      let msg = `📋 *Tareas de ${selectedEmp.fullName} — ${payload.shiftCode}*\n\n`;
      msg += taskService.formatTaskList(empTasks);
      return { reply: msg, employee };
    }

    case 'WAITING_NEXT_TASK_CONFIRM': {
      // ── Empleado completó tarea y el sistema preguntó "¿Vas a iniciar otra?" ──
      // payload: { pendingTasks: [{ id, title, task_id }] }
      const isConfirm = /^(s[ií]|ok|va(?:le)?|dale|confirmo|afirmativo|claro|correcto)(?=\s|$|[,.])/i.test(cleaned);

      if (isConfirm) {
        const pending = payload.pendingTasks || [];
        if (pending.length === 0) {
          await updateSessionState(session.session_id, 'IDLE', {});
          return { reply: 'No tienes tareas pendientes.', employee };
        }
        // Mostrar lista de tareas pendientes para que elija cuál iniciar
        let msg = `📋 *Tus tareas pendientes:*\n\n`;
        pending.forEach((t, i) => {
          const icon = t.task_id ? '📌' : '📋';
          msg += `*${i + 1}.* ${icon} ${t.title}\n`;
        });
        msg += '\n¿Cuál vas a iniciar? Dime el número o el nombre.';
        await updateSessionState(session.session_id, 'IDLE', {});
        return { reply: msg, employee };
      }

      // "no" o cancelar → ya se maneja arriba en el guard general
      // Cualquier otra cosa → reset y procesar normalmente
      await updateSessionState(session.session_id, 'IDLE', {});
      return null;
    }

    default:
      await updateSessionState(session.session_id, 'IDLE', {});
      return null; // Fall through to normal processing
  }
}

module.exports = { processInboundMessage };
