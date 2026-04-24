const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../config/database');
const logger = require('../utils/logger');

const anthropic = new Anthropic.default();

// ─── Local keyword patterns (avoid Claude for simple messages) ───────────────

const LOCAL_PATTERNS = {
  GREETING: {
    patterns: [
      /^(hola|buenos?\s*d[ií]as?|buenas?\s*(tardes?|noches?)|hey|qu[eé]\s*tal|saludos|buen\s*d[ií]a)/i,
    ],
  },
  CHECK_IN: {
    patterns: [
      /^(ya\s+llegu[eé]|ya\s+estoy|present[eo]\b|aqu[ií]\s+estoy|lleg[oó]|report[aáo]n?dome|me\s+reporto|ya\s+vine|estoy\s+aqu[ií]|llegando)/i,
    ],
  },
  STILL_WORKING: {
    // Employee says they're still working (response to end-of-shift reminder)
    // "aún no", "todavía no", "sigo trabajando", "estoy atrasado", "me falta terminar", "necesito más tiempo"
    patterns: [
      /(a[uú]n\s+no|todav[ií]a\s+no|sigo\s+(?:trabajando|atrasado|en\s+eso|ocupado)|estoy\s+atrasad[oa]|me\s+falta\s+terminar|no\s+he\s+terminado|necesito\s+m[aá]s\s+tiempo|a[uú]n\s+(?:estoy\s+)?trabajando|sigo\s+en\s+(?:el\s+)?turno|no\s+(?:he\s+)?termin[oeé]|me\s+falta(?:n)?\s+(?:tareas|cosas|pendientes))/i,
    ],
  },
  CHECK_OUT: {
    patterns: [
      /(estoy\s+saliendo|me\s+voy|ya\s+me\s+voy|termin[eéo]\s+(?:mi\s+)?(?:turno|jornada|d[ií]a)|fin\s+de\s+(?:turno|jornada)|salgo\s+del\s+trabajo|ya\s+sal[ií]|me\s+retiro|finalic[eé]\s+(?:mi\s+)?(?:turno|jornada)|hora\s+de\s+(?:salida|irme)|ya\s+termin[eé]\s+(?:mi\s+)?(?:turno|jornada))/i,
    ],
  },
  // ─── Estados de viaje (tickets de campo tipo NOC) ───────────────────────
  // Se evalúan ANTES de TASK_DONE/TASK_START para evitar colisiones como
  // "ya salí" (que podría matchear CHECK_OUT o NEW_TASK). Por diseño NO
  // usamos "salgo"/"saliendo" a secas — requieren "para/hacia/al/a la ..."
  // para desambiguar del CHECK_OUT.
  TASK_TRAVELING: {
    patterns: [
      /voy\s+(?:en\s+)?camino\b/i,
      /estoy\s+(?:en\s+)?camino\b/i,
      /en\s+camino\b/i,
      /(?:ya\s+)?estoy\s+yendo\b/i,
      /voy\s+para\s+all[aá]\b/i,
      /rumbo\s+(?:al|a\s+la|hacia)\b/i,
      /en\s+ruta\b/i,
      /me\s+dirij[oe]\b/i,
      /yendo\s+(?:al|a\s+la|hacia)\b/i,
      /saliendo\s+(?:para|hacia|al|a\s+la)\b/i,
    ],
  },
  TASK_ON_SITE: {
    // Importante: NO capturar "ya llegué" a secas ni "llegué" solo —
    // esos los usa CHECK_IN al inicio de jornada. TASK_ON_SITE requiere
    // referencia explícita al sitio del ticket/trabajo.
    patterns: [
      /\bllegu[eé]\s+al\s+(?:sitio|lugar|cliente|cuarto|punto|domicilio|edificio|nodo|poste)\b/i,
      /\bllegu[eé]\s+a\s+la\s+(?:ubicaci[oó]n|sede|direcci[oó]n|estaci[oó]n|central|torre|oficina\s+del\s+cliente)\b/i,
      /estoy\s+en\s+(?:el\s+sitio|el\s+lugar|la\s+ubicaci[oó]n|el\s+cliente|el\s+punto|el\s+nodo|el\s+poste)\b/i,
      /\ben\s+(?:el\s+)?sitio\s+(?:ya|del\s+ticket|del\s+trabajo)?/i,
      /llegu[eé]\s+al\s+(?:cliente|trabajo\s+del\s+ticket)\b/i,
    ],
  },

  TASK_DONE: {
    patterns: [
      // "ya terminé", "terminé", "termine", "terminar", "termina", "terminado", "listo", "completado", "hecho", "ya" (sola), etc.
      // Nota: incluimos formas infinitivas (terminar/acabar) y presente (termina/acaba) porque el usuario
      // suele decir "terminar tarea 3" o "termina la limpieza" queriendo marcarla como hecha.
      /(ya\s+)?termin(?:[eéo]|ar|a|ado|ada)\b|^listo$|^terminado$|^completado$|^hecho$|^ya$|acab(?:[eéo]|ar|a|ado|ada)\b|finalic[eé]|finaliza(?:r|do|da)?\b|ya\s+qued[oó]|ya\s+est[aá](\s+listo)?|lo\s+logr[eé]|tarea\s+lista|ya\s+lo\s+hice|marca(?:r|da|do)?\s+(?:como\s+)?(?:hecha|hecho|lista|listo|terminada|terminado|completada|completado)|dar\s+por\s+(?:termin|acab|finaliz)/i,
    ],
  },
  TASK_PROGRESS_RELATIVE: {
    // "10% más", "avancé un 20%", "le sumé 15%", "le metí 25%", "agregué 10%"
    // MUST be checked BEFORE absolute patterns to avoid "avancé un 20%" matching absolute "avance 20%"
    patterns: [
      /(\d{1,3})\s*%\s*m[aá]s/i,
      /avanc[eé]\s+(?:un\s+)?(\d{1,3})\s*%/i,
      /le\s+(?:sum[eé]|met[ií]|ech[eé]|puse|di)\s+(?:un\s+)?(\d{1,3})\s*%/i,
      /sum[aáo]\s+(?:un\s+)?(\d{1,3})\s*%/i,
      /agregu[eé]\s+(?:un\s+)?(\d{1,3})\s*%/i,
    ],
  },
  TASK_PROGRESS_WITH_PERCENT: {
    patterns: [
      /(\d{1,3})\s*(%|por\s*ciento|porciento)/i,
      /avance?\s*(?:de\s*)?(\d{1,3})\s*%?/i,
      /progreso\s*(?:de\s*)?(\d{1,3})\s*%?/i,
      /llevo\s*(?:el\s*)?(\d{1,3})\s*%?/i,
      /(?:voy|ando)\s*(?:en\s*(?:el\s*)?)?(\d{1,3})\s*%/i,
    ],
  },
  TASK_PROGRESS_VERBAL: {
    // "llevo la mitad", "casi termino", "me falta poco" → progress sin porcentaje exacto
    patterns: [
      /llevo\s+la\s+mitad/i,
      /a\s+la\s+mitad/i,
      /casi\s+termino/i,
      /casi\s+listo/i,
      /me\s+falta\s+poco/i,
      /ya\s+mero/i,
      /ya\s+casi/i,
      /falta\s+poco/i,
    ],
  },
  TASK_BLOCKED: {
    patterns: [
      /(bloqueado|no\s+puedo|impedido|detenido|parado|atascado|trancado|estancado|sin\s+poder|no\s+hay|no\s+tengo|se\s+acab[oó]|no\s+funciona|no\s+sirve|no\s+alcanza|necesito\s+ayuda|eliminar\s+tarea|tarea.*eliminar)/i,
    ],
  },
  VAGUE_MESSAGE: {
    patterns: [
      /^(trabajando|limpiando|arreglando|haciendo|avanzando|en\s+eso|aqu[ií]|bien|normal|todo\s+bien|ya\s+avanc[eé]|ah[ií]\s+voy|ah[ií]\s+ando|dale|ok|va|sale|sigo)$/i,
    ],
  },
  TASK_LIST_REQUEST: {
    patterns: [
      /(qu[eé]\s+tengo|mis\s+tareas|qu[eé]\s+hago|qu[eé]\s+me\s+toca|tareas\s+del\s+d[ií]a|plan\s+del\s+d[ií]a|qu[eé]\s+debo|ver\s+tareas|lista\s+de\s+tareas|pendientes)/i,
    ],
  },
  NEW_TASK: {
    patterns: [
      // "voy a hacer X", "voy a limpiar X", "iniciando X", "empezando X", etc.
      // "estoy limpiando/barriendo/fregando..." (estoy + cualquier gerundio -ando/-endo/-iendo)
      /(voy\s+a\s+\w+|empiezo\s+(?:con\s+|a\s+)?(?:la|el|los|las|tarea)?\s*\w+|nueva\s+tarea|(?:tarea|actividad)\s+nueva|inicio\s+tarea|comienzo\s+(?:con|a)|me\s+pongo\s+(?:con|a)|estoy\s+\w+(?:ando|endo|iendo)\b|iniciando\s+\w+|empezando(?:\s+\w+)?|comenzando\s+\w+|arranco\s+(?:con|a)\s+\w+|inicie\s+(?:una?\s+)?(?:nueva?\s+)?(?:tarea|actividad))/i,
    ],
  },
  // ─── Manager-only intents ──────────────────────────────────────
  MANAGER_DASHBOARD: {
    patterns: [
      /(dashboard|resumen\s+(?:del?\s+)?(?:equipo|d[ií]a|general)|reporte\s+(?:del?\s+)?(?:d[ií]a|equipo|diario)|c[oó]mo\s+va(?:n?\s+(?:el\s+)?(?:equipo|todo|las\s+cosas))?|estado\s+general)/i,
    ],
  },
  MANAGER_ATTENDANCE: {
    patterns: [
      /(qui[eé]n(?:es)?\s+(?:ha[n]?\s+)?(?:llegado|reportado|venido|checado)|asistencia|qui[eé]n\s+falta|qui[eé]n\s+lleg[oó]|lista\s+de\s+asistencia|presentes|ausentes|qui[eé]n(?:es)?\s+(?:est[aá]n?|anda[n]?)(?:\s+(?:aqu[ií]|hoy))?|qui[eé]n\s+vino)/i,
    ],
  },
  MANAGER_TASKS: {
    patterns: [
      /(c[oó]mo\s+van\s+(?:las\s+)?tareas|avance(?:s)?\s+(?:del?\s+)?(?:equipo|todos)|progreso\s+(?:del?\s+)?equipo|estado\s+de\s+tareas|tareas\s+(?:del?\s+)?equipo|qu[eé]\s+han\s+hecho|qu[eé]\s+(?:se\s+)?ha\s+(?:hecho|completado|avanzado))/i,
    ],
  },
  MANAGER_REPORT: {
    patterns: [
      /(productividad|rendimiento|eficiencia|reporte\s+de\s+(?:tiempo|productividad|rendimiento)|tiempos?\s+(?:del?\s+)?(?:equipo|d[ií]a)|cu[aá]nto\s+(?:tiempo|tardaron|llevan)|horas\s+trabajadas|tiempo\s+real)/i,
    ],
  },
  MANAGER_SHIFTS: {
    patterns: [
      /(qu[eé]\s+turnos|cu[aá]les\s+turnos|los\s+turnos|turnos\s+(?:de\s+)?hoy|turnos\s+del\s+d[ií]a|qui[eé]n(?:es)?\s+trabaja(?:n)?\s+hoy|personal\s+(?:de\s+)?hoy|qu[eé]\s+(?:gente|personal)\s+(?:hay|tenemos|viene)|cu[aá]ntos?\s+turnos)/i,
    ],
  },
  ASSIGN_TASK: {
    patterns: [
      /asignar?\s+(?:una?\s+)?tareas?/i,
      /poner\s+(?:una?\s+)?tareas?/i,
      /quiero\s+asignar(?:le)?\s+(?:una?\s+)?tareas?/i,
      /voy\s+a\s+asignar/i,
      /crear?\s+(?:una?\s+)?tareas?\s+(?:para|a)\s/i,
      /nueva\s+tareas?\s+para/i,
      /asignar\s+(?:actividad|trabajo)/i,
      /asignar\s+(?:una?\s+)?actividad/i,
    ],
  },
};

// ─── Spanish number words → digits (Whisper often transcribes numbers as words) ──
const SPANISH_NUMBERS = {
  cero: 0, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14,
  quince: 15, veinte: 20, veinticinco: 25, treinta: 30, cuarenta: 40,
  cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100,
};

function normalizeSpanishNumbers(text) {
  return text.replace(
    /\b(cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|veinticinco|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien)\b/gi,
    (match) => String(SPANISH_NUMBERS[match.toLowerCase()])
  );
}

function tryLocalNLP(text) {
  const cleaned = normalizeSpanishNumbers(text.trim());

  // Check VAGUE first (exact short messages that need clarification)
  for (const p of LOCAL_PATTERNS.VAGUE_MESSAGE.patterns) {
    if (p.test(cleaned)) {
      return {
        intent: 'VAGUE_MESSAGE',
        confidence: 0.95,
        entities: {},
        usedClaude: false,
      };
    }
  }

  // Check check-in (GREETING moved to end so actionable intents take priority)
  for (const p of LOCAL_PATTERNS.CHECK_IN.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'CHECK_IN', confidence: 0.95, entities: {}, usedClaude: false };
    }
  }

  // Check "still working" BEFORE check-out (to avoid "no terminé" matching CHECK_OUT)
  for (const p of LOCAL_PATTERNS.STILL_WORKING.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'STILL_WORKING', confidence: 0.9, entities: {}, usedClaude: false };
    }
  }

  // Check check-out ("estoy saliendo", "me voy", "terminé mi turno")
  for (const p of LOCAL_PATTERNS.CHECK_OUT.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'CHECK_OUT', confidence: 0.9, entities: {}, usedClaude: false };
    }
  }

  // Check ASSIGN_TASK before TASK_LIST_REQUEST (both contain "tarea/s")
  for (const p of LOCAL_PATTERNS.ASSIGN_TASK.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'ASSIGN_TASK', confidence: 0.9, entities: {}, usedClaude: false };
    }
  }

  // Check task list request
  for (const p of LOCAL_PATTERNS.TASK_LIST_REQUEST.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'TASK_LIST_REQUEST', confidence: 0.9, entities: {}, usedClaude: false };
    }
  }
  for (const p of LOCAL_PATTERNS.MANAGER_SHIFTS.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'MANAGER_SHIFTS', confidence: 0.9, entities: {}, usedClaude: false };
    }
  }
  for (const p of LOCAL_PATTERNS.MANAGER_REPORT.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'MANAGER_REPORT', confidence: 0.9, entities: {}, usedClaude: false };
    }
  }
  for (const p of LOCAL_PATTERNS.MANAGER_TASKS.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'MANAGER_TASKS', confidence: 0.9, entities: {}, usedClaude: false };
    }
  }
  for (const p of LOCAL_PATTERNS.MANAGER_ATTENDANCE.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'MANAGER_ATTENDANCE', confidence: 0.9, entities: {}, usedClaude: false };
    }
  }
  for (const p of LOCAL_PATTERNS.MANAGER_DASHBOARD.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'MANAGER_DASHBOARD', confidence: 0.9, entities: {}, usedClaude: false };
    }
  }

  // Check RELATIVE progress FIRST ("10% más", "avancé un 20%")
  // Must be before absolute to avoid "avancé un 20%" matching absolute "avance 20%"
  for (const p of LOCAL_PATTERNS.TASK_PROGRESS_RELATIVE.patterns) {
    const match = cleaned.match(p);
    if (match) {
      const percent = parseInt(match[1]);
      if (percent > 0 && percent <= 100) {
        return {
          intent: 'TASK_PROGRESS',
          confidence: 0.9,
          entities: { progress_percent: percent, is_relative: true },
          usedClaude: false,
        };
      }
    }
  }

  // Check progress with percentage (absolute)
  for (const p of LOCAL_PATTERNS.TASK_PROGRESS_WITH_PERCENT.patterns) {
    const match = cleaned.match(p);
    if (match) {
      const percent = parseInt(match[1]);
      if (percent >= 0 && percent <= 100) {
        return {
          intent: 'TASK_PROGRESS',
          confidence: 0.9,
          entities: { progress_percent: percent },
          usedClaude: false,
        };
      }
    }
  }

  // Check verbal progress BEFORE done ("casi termino" = 85%, not done!)
  for (const p of LOCAL_PATTERNS.TASK_PROGRESS_VERBAL.patterns) {
    if (p.test(cleaned)) {
      let percent = 50;
      if (/casi|mero|falta\s+poco/i.test(cleaned)) percent = 85;
      if (/mitad/i.test(cleaned)) percent = 50;
      return {
        intent: 'TASK_PROGRESS',
        confidence: 0.85,
        entities: { progress_percent: percent, note_text: cleaned },
        usedClaude: false,
      };
    }
  }

  // Check traveling / on_site (tickets de campo) — ANTES de TASK_DONE/TASK_START
  // para que "llegué", "voy en camino", etc. se detecten como transiciones
  // del ticket activo, no como finalización.
  for (const p of LOCAL_PATTERNS.TASK_ON_SITE.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'TASK_ON_SITE', confidence: 0.85, entities: {}, usedClaude: false };
    }
  }
  for (const p of LOCAL_PATTERNS.TASK_TRAVELING.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'TASK_TRAVELING', confidence: 0.85, entities: {}, usedClaude: false };
    }
  }

  // Check done (after verbal progress, so "casi termino" doesn't match here)
  for (const p of LOCAL_PATTERNS.TASK_DONE.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'TASK_DONE', confidence: 0.9, entities: {}, usedClaude: false };
    }
  }

  // Check blocked
  for (const p of LOCAL_PATTERNS.TASK_BLOCKED.patterns) {
    if (p.test(cleaned)) {
      const reasonMatch = cleaned.match(/(?:bloqueado|no\s+puedo|impedido|detenido|parado|no\s+hay|no\s+tengo|se\s+acab[oó]|no\s+funciona|no\s+sirve|necesito\s+ayuda)[\s,.:]+(.+)/i);
      return {
        intent: 'TASK_BLOCKED',
        confidence: 0.85,
        entities: { blocker_text: reasonMatch ? reasonMatch[1].trim() : null },
        usedClaude: false,
      };
    }
  }

  // Check new task
  for (const p of LOCAL_PATTERNS.NEW_TASK.patterns) {
    if (p.test(cleaned)) {
      // Extract task title: strip command prefix, keep task description
      // "voy a hacer limpieza" → "limpieza" (not "hacer limpieza")
      // "voy a limpiar la entrada" → "limpiar la entrada"
      // "iniciando limpieza de baños" → "limpieza de baños"
      const taskMatch = cleaned.match(/(?:voy\s+a\s+hacer|voy\s+a|empiezo\s+(?:con\s+|a\s+)?|nueva\s+tarea:?\s*|inicio\s+tarea:?\s*|comienzo\s+(?:con|a)|me\s+pongo\s+(?:con|a)|estoy\s+(?:en|haciendo|iniciando)|iniciando|empezando|comenzando|arranco\s+(?:con|a))\s+(.+)/i);
      let title = taskMatch ? taskMatch[1].trim() : null;
      // Strip leftover action verbs: "iniciar limpieza" → "limpieza"
      if (title) {
        title = title.replace(/^(?:in[ií]ciar|hacer|realizar|empezar|comenzar|arrancar|terminar|completar|continuar)\s+/i, '').trim();
      }
      return {
        intent: 'TASK_CREATE',
        confidence: 0.85,
        entities: { task_title: title },
        usedClaude: false,
      };
    }
  }

  // Check greeting LAST — so "hola que tareas tengo?" matches TASK_LIST, not GREETING
  // Simple "hola" or "buenos dias" still matches here since nothing else caught it
  for (const p of LOCAL_PATTERNS.GREETING.patterns) {
    if (p.test(cleaned)) {
      return { intent: 'GREETING', confidence: 0.95, entities: {}, usedClaude: false };
    }
  }

  return null; // No local match, needs Claude
}

// ─── Claude Haiku 4.5 for complex messages (fast + cheap) ────────────────────
// Haiku 3.5 fue RETIRADO el 2026-02-19. Usar Haiku 4.5 en adelante.
// 'claude-haiku-4-5' → $1/MTok input, $5/MTok output (el mas barato disponible)
// Alternativa: 'claude-sonnet-4-6' → $3/MTok input, $15/MTok output
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';

const CLAUDE_SYSTEM_PROMPT = `Eres un asistente de NLP para un sistema de gestión de tareas de empleados.
Tu trabajo es analizar mensajes de empleados (en español) y extraer la intención y entidades.

Responde SIEMPRE en JSON válido con esta estructura exacta:
{
  "intent": "TASK_DONE|TASK_PROGRESS|TASK_BLOCKED|TASK_START|TASK_PAUSE|TASK_SWITCH|TASK_CREATE|TASK_TRAVELING|TASK_ON_SITE|CHECK_IN|CHECK_OUT|TASK_LIST_REQUEST|GREETING|UNKNOWN",
  "confidence": 0.0-1.0,
  "entities": {
    "task_title": "nombre EXACTO de la tarea del listado (si aplica) o nombre de nueva tarea",
    "task_number": número_de_tarea_en_lista_o_null,
    "progress_percent": número_o_null,
    "is_relative": true_si_avance_relativo_o_false,
    "blocker_text": "razón del bloqueo o null",
    "note_text": "resumen del mensaje o null"
  }
}

REGLAS CRÍTICAS:
- Si el empleado tiene un LISTADO DE TAREAS y menciona un número ("la 1", "tarea 2", "#3") o un nombre parcial que coincide con una tarea existente, usa TASK_START (NO TASK_CREATE). Pon el task_number y task_title del listado.
- "empiezo con la 1", "inicio la tarea 2", "me pongo con la 3" → TASK_START con task_number
- "limpieza entrada" cuando existe "Limpieza Entrada Principal Planta Baja" → TASK_START con task_title exacto del listado
- TASK_CREATE solo cuando el empleado describe algo genuinamente NUEVO que no existe en su lista
- "ya terminé", "listo", "completado", "ya" (sola) → TASK_DONE
- IMPORTANTE — formas verbales de "terminar/acabar": "terminar tarea 3", "termina la 2", "termino la limpieza",
  "acabar la 1", "marca como hecha la 3", "dar por terminada", "finalizar" → TODO ESTO es TASK_DONE
  (con task_number o task_title si se refiere a una tarea del listado). NUNCA confundas el infinitivo
  "terminar" con "iniciar" — en este dominio significa "dar por terminada".
- "voy a terminar la limpieza" → ambiguo: puede ser DONE (marcarla hecha) o PROGRESS (casi terminar).
  Si el listado tiene la tarea en 'in_progress' con progreso >60%, usa TASK_DONE. Si no, TASK_PROGRESS 85%.
- Si hay VARIAS tareas en estado 'in_progress' y el empleado dice algo genérico como "termine" o "listo"
  SIN número ni nombre, devuelve TASK_DONE pero con task_number=null y task_title=null — el sistema
  le pedirá que aclare cuál. NO adivines.
- Si el empleado dice "voy a hacer X" cuando ya tiene Y 'in_progress', devuelve TASK_START con task_title
  de la nueva — el sistema le preguntará qué hacer con Y (pausar, terminar, paralelo).
- "avancé 50%", "llevo la mitad" → TASK_PROGRESS con progress_percent
- "10% más", "avancé un 20%", "le sumé 15%" → TASK_PROGRESS con progress_percent e is_relative: true
- "no puedo avanzar porque..." → TASK_BLOCKED
- "me reporto", "ya llegué" (al inicio del turno, antes del check-in) → CHECK_IN
- "estoy saliendo", "me voy", "terminé mi turno" → CHECK_OUT
- "voy en camino al cliente", "rumbo al sitio", "saliendo hacia el nodo", "en ruta" → TASK_TRAVELING (el técnico se mueve hacia el lugar del ticket; NO CHECK_IN)
- "llegué al sitio", "estoy en el cliente", "en el lugar del ticket" → TASK_ON_SITE (ya está en el lugar del trabajo pero aún no inició)
- Atención: TASK_TRAVELING/TASK_ON_SITE aplican SOLO a empleados que ya hicieron check-in y tienen ticket activo. Si el mensaje es ambiguo ("ya llegué") y el empleado NO tiene tarea in_progress, prefiere CHECK_IN.
- Números aislados como "50" o "80" → porcentaje de avance
- Mensajes ambiguos o muy cortos (ej: "bien", "normal") → UNKNOWN

SOLO responde con el JSON, sin texto adicional.`;

const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS) || 10_000; // 10s default

async function analyzeWithClaude(text, employeeContext) {
  try {
    let userMessage = `Mensaje del empleado: "${text}"`;
    if (employeeContext) {
      userMessage += `\n\nContexto: Empleado "${employeeContext.full_name}", departamento "${employeeContext.dept_name || 'N/A'}"`;
      if (employeeContext.currentTask) {
        userMessage += `, tarea actual: "${employeeContext.currentTask.title}" (${employeeContext.currentTask.status}, ${employeeContext.currentTask.progress_percent || 0}%)`;
      }
      // Enviar lista de tareas para que Claude pueda resolver referencias
      if (employeeContext.todayTasks && employeeContext.todayTasks.length > 0) {
        userMessage += `\n\nListado de tareas de hoy:`;
        employeeContext.todayTasks.forEach((t, i) => {
          userMessage += `\n${i + 1}. "${t.title}" (${t.status}, ${t.progress_percent || 0}%)`;
        });
        userMessage += `\n\nIMPORTANTE: Si el empleado menciona un número o nombre parcial, relaciónalo con esta lista. Usa TASK_START (no TASK_CREATE) si coincide con una tarea existente.`;
      }
    }

    // Timeout: si Claude no responde en X segundos, abortar
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      system: CLAUDE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }, { signal: controller.signal });

    clearTimeout(timeoutId);

    let content = response.content[0].text.trim();
    // Strip markdown code fences if Claude wraps JSON in ```json ... ```
    content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(content);

    return {
      intent: parsed.intent || 'UNKNOWN',
      confidence: parsed.confidence || 0.5,
      entities: parsed.entities || {},
      usedClaude: true,
      model: CLAUDE_MODEL,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (err) {
    const isTimeout = err.name === 'AbortError' || err.message?.includes('abort');
    const isOverloaded = err.status === 529 || err.status === 503 || err.message?.includes('overloaded');
    const isRateLimit = err.status === 429;

    if (isTimeout) {
      logger.warn('Claude API timeout', { timeoutMs: CLAUDE_TIMEOUT_MS });
    } else if (isOverloaded) {
      logger.warn('Claude API overloaded', { status: err.status });
    } else if (isRateLimit) {
      logger.warn('Claude API rate limited', { status: err.status });
    } else {
      logger.error('Claude NLP analysis failed', { err: err.message });
    }

    return {
      intent: 'UNKNOWN',
      confidence: 0,
      entities: {},
      usedClaude: true,
      error: isTimeout ? 'timeout' : isOverloaded ? 'overloaded' : isRateLimit ? 'rate_limited' : err.message,
      isTransient: isTimeout || isOverloaded || isRateLimit,
    };
  }
}

// ─── Main NLP pipeline ──────────────────────────────────────────────────────

// Intents donde el contexto de tareas en progreso importa para desambiguar
const CONTEXT_SENSITIVE_INTENTS = new Set(['TASK_DONE', 'TASK_PROGRESS', 'TASK_START', 'TASK_BLOCKED', 'TASK_CREATE']);

async function analyze(text, employeeContext) {
  // Calcular si el contexto del empleado es "ambiguo":
  // tiene múltiples tareas in_progress Y el mensaje NO contiene una referencia clara
  // (número o nombre largo). Si es ambiguo, NO confiamos en el NLP local aunque diga 0.9 —
  // dejamos que Claude vea la lista completa y decida.
  const inProgressCount = (employeeContext?.todayTasks || [])
    .filter(t => t.status === 'in_progress').length;
  const hasExplicitRef = /\d+|tarea\s+\w+|la\s+(primera|segunda|tercera|[uú]ltima)/i.test(text);
  const contextIsAmbiguous = inProgressCount > 1 && !hasExplicitRef;

  // Step 1: Try local patterns first (no cost)
  const localResult = tryLocalNLP(text);
  if (localResult && localResult.confidence >= 0.8) {
    // Si el contexto es ambiguo Y el intent local depende del contexto de tareas,
    // consultar Claude como "segunda opinión" para que vea la lista y decida mejor.
    if (contextIsAmbiguous && CONTEXT_SENSITIVE_INTENTS.has(localResult.intent)) {
      logger.info('NLP: Contexto ambiguo (múltiples tareas in_progress), consultando Claude', {
        localIntent: localResult.intent, inProgressCount,
      });
      const claudeResult = await analyzeWithClaude(text, employeeContext);
      // Solo usar Claude si devuelve algo útil; si falla, caer a local
      if (claudeResult && claudeResult.intent !== 'UNKNOWN' && !claudeResult.error) {
        return claudeResult;
      }
      logger.info('NLP: Claude no ayudó, usando resultado local', { intent: localResult.intent });
      return localResult;
    }
    logger.info('NLP: Local match', { intent: localResult.intent, confidence: localResult.confidence });
    return localResult;
  }

  // Step 2: Also check keyword_dictionary from DB
  const dbResult = await tryDatabaseKeywords(text);
  if (dbResult && dbResult.confidence >= 0.8 && !contextIsAmbiguous) {
    logger.info('NLP: DB keyword match', { intent: dbResult.intent });
    return dbResult;
  }

  // Step 3: Use Claude for complex messages
  logger.info('NLP: Sending to Claude', { textLength: text.length, contextIsAmbiguous });
  const claudeResult = await analyzeWithClaude(text, employeeContext);
  return claudeResult;
}

async function tryDatabaseKeywords(text) {
  try {
    const res = await query(
      `SELECT category, pattern, is_regex, weight
       FROM keyword_dictionary
       WHERE is_active = true
       ORDER BY weight DESC`
    );

    const cleaned = text.toLowerCase().trim();
    let bestMatch = null;
    let bestWeight = 0;

    for (const kw of res.rows) {
      let matched = false;
      if (kw.is_regex) {
        try {
          const re = new RegExp(kw.pattern, 'i');
          matched = re.test(cleaned);
        } catch {
          continue;
        }
      } else {
        matched = cleaned.includes(kw.pattern.toLowerCase());
      }

      if (matched && kw.weight > bestWeight) {
        bestWeight = kw.weight;
        const intentMap = {
          DONE: 'TASK_DONE',
          PROGRESS: 'TASK_PROGRESS',
          BLOCKER: 'TASK_BLOCKED',
          START: 'TASK_START',
          PAUSE: 'TASK_PAUSE',
        };
        bestMatch = {
          intent: intentMap[kw.category] || 'UNKNOWN',
          confidence: Math.min(0.7 + kw.weight * 0.03, 0.95),
          entities: {},
          usedClaude: false,
          source: 'keyword_dictionary',
        };
      }
    }
    return bestMatch;
  } catch (err) {
    logger.warn('DB keyword lookup failed', { err: err.message });
    return null;
  }
}

async function saveExtraction(messageId, employeeId, workDate, result, instanceId) {
  try {
    await query(
      `INSERT INTO nlp_message_extractions
        (message_id, employee_id, work_date, intent, confidence,
         normalized_task_text, progress_percent, blocker_text,
         instance_id, entities, model_info, processed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
      [
        messageId,
        employeeId,
        workDate,
        result.intent === 'CHECK_IN' || result.intent === 'CHECK_OUT' || result.intent === 'GREETING' || result.intent === 'TASK_LIST_REQUEST' || result.intent === 'VAGUE_MESSAGE' || result.intent === 'STILL_WORKING' || result.intent.startsWith('MANAGER_')
          ? 'UNKNOWN'
          : result.intent,
        result.confidence,
        result.entities?.task_title || result.entities?.note_text || null,
        result.entities?.progress_percent || null,
        result.entities?.blocker_text || null,
        instanceId || null,
        JSON.stringify(result.entities || {}),
        JSON.stringify({
          usedClaude: result.usedClaude,
          model: result.model || null,
          inputTokens: result.inputTokens || 0,
          outputTokens: result.outputTokens || 0,
        }),
      ]
    );
  } catch (err) {
    logger.warn('saveExtraction failed', { err: err.message });
  }
}

module.exports = { analyze, saveExtraction, tryLocalNLP, analyzeWithClaude, normalizeSpanishNumbers };
