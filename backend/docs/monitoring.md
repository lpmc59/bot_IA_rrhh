# Monitoring — Fase de evaluación post fixes 1–5

Este documento recoge las queries y señales que debemos medir durante ~2
semanas después de haber desplegado los fixes 1–5 del análisis de bugs del
flujo de conversación (Nov 2026). El objetivo es decidir con **datos reales**
si vale la pena implementar `TASK_SWITCH` (fase 2) o si los fixes atómicos
actuales son suficientes.

## Contexto

Los fixes 1–5 cubrieron:

| Fix | Qué arregla |
|-----|-------------|
| **#1** | Regex `terminar` infinitivo/presente en TASK_DONE (nlpService + messageService). |
| **#2** | `handleTaskStart` pregunta qué hacer con tarea(s) en progreso antes de iniciar otra. Nuevo estado `WAITING_SWITCH_CONFIRM`. |
| **#3** | `handleTaskDone` con >1 tarea in_progress pide al empleado que aclare cuál terminó (en vez de asumir la más reciente). |
| **#4** | `WAITING_TASK_PICK` re-muestra la lista si llega un "termine" ambiguo, evita silent reply. |
| **#5** | Claude Haiku 4.5 como second-opinion cuando el contexto es ambiguo (>1 tarea in_progress y mensaje sin referencia explícita). System prompt actualizado. |

`TASK_SWITCH` (intent compuesto *"terminé X, ahora voy con Y"* en un solo
mensaje) queda **diferido** hasta tener datos de uso.

## Tablas relevantes

| Tabla | Uso |
|-------|-----|
| `app.chat_sessions` | Estado actual del state machine por empleado. Columnas: `session_id`, `employee_id`, `state`, `state_payload`, `last_inbound_at`, `last_outbound_at`, `updated_at`. |
| `app.chat_messages` | Histórico de mensajes in/out. Columnas: `message_id`, `employee_id`, `direction`, `message_text`, `received_ts`, `channel`. |
| `app.nlp_message_extractions` | Resultado del NLP por mensaje. Columnas: `intent`, `confidence`, `entities`, `model_info` (incluye `usedClaude`, `model`, `inputTokens`, `outputTokens`), `created_at`. |

---

## Señal 1 — Frecuencia del `WAITING_SWITCH_CONFIRM` (Fix #2)

**Pregunta**: ¿Qué tan seguido los empleados intentan iniciar una tarea
cuando ya tienen otra en progreso?

`app.chat_sessions` solo guarda el estado **actual**, no histórico. Para
capturar transiciones necesitamos o bien logging estructurado en el backend
o una tabla auxiliar. Opción rápida: mirar sesiones que están actualmente
en ese estado (muestreo puntual a lo largo del día).

```sql
-- Snapshot puntual: cuántas sesiones están AHORA en WAITING_SWITCH_CONFIRM
SELECT state, COUNT(*) AS sesiones
FROM app.chat_sessions
WHERE state IN (
  'WAITING_SWITCH_CONFIRM',
  'WAITING_TASK_PICK',
  'WAITING_BACKLOG_DONE_CONFIRM'
)
GROUP BY state;
```

Para medición longitudinal agregar al backend un log estructurado cuando
se entra en ese estado. En `messageService.js` dentro de `handleTaskStart`
justo antes del `updateSessionState(..., 'WAITING_SWITCH_CONFIRM', ...)`:

```js
logger.info('state_transition', {
  from: session.state,
  to: 'WAITING_SWITCH_CONFIRM',
  employeeId: employee.employee_id,
  inProgressCount: inProgressList.length,
});
```

Luego contar en logs (ej. CloudWatch / journalctl) con `grep state_transition`
agregado por día.

**Umbral de decisión**: si >15% de los `TASK_START` terminan pasando por
`WAITING_SWITCH_CONFIRM` durante 2 semanas → implementar `TASK_SWITCH` vale
la pena.

---

## Señal 2 — Abandonos mid-flujo en estados WAITING

**Pregunta**: ¿Los empleados se atoran en pickers multi-turno y los dejan
huérfanos?

```sql
-- Sesiones que quedaron en un estado WAITING por más de 10 minutos
-- sin movimiento. Indica abandono del flujo.
SELECT state, COUNT(*) AS huerfanas
FROM app.chat_sessions
WHERE state LIKE 'WAITING_%'
  AND state != 'IDLE'
  AND updated_at < NOW() - INTERVAL '10 minutes'
  AND (last_inbound_at IS NULL OR last_inbound_at < NOW() - INTERVAL '10 minutes')
GROUP BY state
ORDER BY huerfanas DESC;
```

```sql
-- Sesiones limpias: hora del día en que suelen quedar huérfanas
-- (para entender si es por cambio de turno / descanso)
SELECT DATE_TRUNC('hour', updated_at) AS hora,
       state,
       COUNT(*) AS cantidad
FROM app.chat_sessions
WHERE state LIKE 'WAITING_%'
  AND updated_at >= NOW() - INTERVAL '14 days'
  AND updated_at < NOW() - INTERVAL '15 minutes'
GROUP BY hora, state
ORDER BY hora DESC, cantidad DESC;
```

**Umbral**: si >10% de las sesiones en `WAITING_SWITCH_CONFIRM` o
`WAITING_TASK_PICK` quedan huérfanas → el flujo multi-turno está frustrando
a los empleados → TASK_SWITCH.

---

## Señal 3 — Uso efectivo de Claude API (Fix #5)

**Pregunta**: ¿Cuántos mensajes realmente se están yendo a Claude, y con
qué intent resultan?

```sql
-- % de mensajes que pasaron por Claude (últimos 14 días)
SELECT DATE(created_at) AS dia,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE (model_info->>'usedClaude')::boolean = true) AS via_claude,
       ROUND(
         100.0 * COUNT(*) FILTER (WHERE (model_info->>'usedClaude')::boolean = true)
         / NULLIF(COUNT(*), 0),
         1
       ) AS pct_claude
FROM app.nlp_message_extractions
WHERE created_at >= NOW() - INTERVAL '14 days'
GROUP BY dia
ORDER BY dia DESC;
```

```sql
-- Distribución de intents que Claude devuelve (vs. intents locales)
SELECT intent,
       COUNT(*) FILTER (WHERE (model_info->>'usedClaude')::boolean = true) AS claude,
       COUNT(*) FILTER (WHERE (model_info->>'usedClaude')::boolean = false) AS local
FROM app.nlp_message_extractions
WHERE created_at >= NOW() - INTERVAL '14 days'
GROUP BY intent
ORDER BY claude + local DESC;
```

```sql
-- Costo estimado de Claude (últimos 14 días)
-- Precios Haiku 4.5: $1/MTok input, $5/MTok output
SELECT
  SUM((model_info->>'inputTokens')::int) AS input_tokens,
  SUM((model_info->>'outputTokens')::int) AS output_tokens,
  ROUND(
    SUM((model_info->>'inputTokens')::int) * 1.0 / 1000000 +
    SUM((model_info->>'outputTokens')::int) * 5.0 / 1000000,
    4
  ) AS costo_usd_estimado
FROM app.nlp_message_extractions
WHERE created_at >= NOW() - INTERVAL '14 days'
  AND (model_info->>'usedClaude')::boolean = true;
```

**Umbrales de decisión**:
- `pct_claude` >30%: los regex locales están demasiado estrictos, revisar
  patrones antes de añadir más complejidad.
- `pct_claude` <5%: Claude está subutilizado, bajar el umbral de confianza
  local en más casos.
- Costo >$1/día: considerar timeouts más agresivos o caché de intents
  comunes.

---

## Señal 4 — Patrones compuestos que Claude detecta pero no procesamos

**Pregunta**: ¿Claude está devolviendo `TASK_SWITCH` (que el schema JSON
lista pero ningún handler procesa)? Si sí, los empleados ya están hablando
en compuesto y `TASK_SWITCH` está justificado.

Primero hay que registrarlo. Agregar en `nlpService.js` dentro de
`analyzeWithClaude` justo después del `JSON.parse(content)`:

```js
if (parsed.intent === 'TASK_SWITCH') {
  logger.info('claude_returned_task_switch', {
    text: text.substring(0, 200),
    entities: parsed.entities,
  });
}
```

Luego grep en logs:
```bash
grep claude_returned_task_switch /var/log/talinda-backend.log | wc -l
```

O, si queremos dejarlo en DB, `nlp_message_extractions.intent` acepta el
enum `app.nlp_intent`. Verificar si `TASK_SWITCH` ya está en ese enum:

```sql
SELECT enum_range(NULL::app.nlp_intent);
```

Si no está, `saveExtraction` lo guardará como `UNKNOWN` (porque el código
remapea algunos). Para capturarlo en DB habría que añadirlo al enum con
una migración futura si decidimos implementarlo.

**Umbral**: si Claude devuelve `TASK_SWITCH` >5 veces/día consistentemente
durante 2 semanas → fase 2 justificada.

---

## Señal 5 — Re-impresiones del picker (Fix #4)

**Pregunta**: ¿Los empleados repiten "termine" dentro de `WAITING_TASK_PICK`
porque no entienden cómo responder?

```sql
-- Mensajes in que contienen una forma de "terminar" mientras el empleado
-- estaba (al momento del mensaje) en WAITING_TASK_PICK.
-- Aproximación: mensajes recibidos en una ventana ±1min del updated_at
-- de una sesión en ese estado.
SELECT COUNT(*) AS repeticiones_terminar_en_picker
FROM app.chat_messages cm
JOIN app.chat_sessions cs ON cs.employee_id = cm.employee_id
WHERE cm.direction = 'in'
  AND cm.message_text ~* '^(termin[eéoa]r?|listo|hecho|completado|acab|finaliz)'
  AND cs.state = 'WAITING_TASK_PICK'
  AND cm.received_ts BETWEEN cs.updated_at - INTERVAL '1 minute'
                         AND cs.updated_at + INTERVAL '1 minute'
  AND cm.received_ts >= NOW() - INTERVAL '14 days';
```

Más preciso si logueamos cuando se dispara la rama "re-mostrar lista" del
Fix #4. Agregar en `messageService.js` dentro de esa rama:

```js
logger.info('picker_reprint_triggered', {
  employeeId: employee.employee_id,
  optionsCount: options.length,
});
```

**Umbral**: si >20% de los pickers reciben un "termine" repetido → mejorar
el texto del picker antes de ir a TASK_SWITCH. Ejemplo: cambiar el encabezado
a `"Responde con el NÚMERO de la tarea (ej: '1' o '1,3')"` más explícito.

---

## Señal 6 — Mensajes que caen en UNKNOWN con tareas en progreso

**Pregunta**: ¿Cuántos mensajes no los entiende ni el NLP local ni Claude?
Esos son los "silent failures" que confunden al empleado.

```sql
-- Mensajes UNKNOWN con confianza baja en los últimos 14 días,
-- agrupados para ver patrones repetidos
SELECT
  LEFT(LOWER(normalized_task_text), 50) AS mensaje_truncado,
  COUNT(*) AS veces,
  AVG(confidence) AS conf_promedio
FROM app.nlp_message_extractions
WHERE intent = 'UNKNOWN'
  AND created_at >= NOW() - INTERVAL '14 days'
  AND normalized_task_text IS NOT NULL
GROUP BY mensaje_truncado
HAVING COUNT(*) >= 2
ORDER BY veces DESC
LIMIT 30;
```

Si aparecen patrones repetidos (ej. "ya me fui", "lo acabo de hacer"),
son candidatos a agregar al regex local o al DB keyword dictionary.

---

## Checklist de revisión (al cabo de 2 semanas)

- [ ] Correr Señal 1 y anotar `pct` de `TASK_START` que entran a
  `WAITING_SWITCH_CONFIRM`.
- [ ] Correr Señal 2 y anotar sesiones huérfanas.
- [ ] Correr Señal 3 y revisar distribución + costo.
- [ ] Revisar logs de `claude_returned_task_switch` (Señal 4).
- [ ] Correr Señal 5 y/o revisar logs de `picker_reprint_triggered`.
- [ ] Correr Señal 6 y extraer top-10 mensajes UNKNOWN repetidos.
- [ ] Correr Señal 7.1 — volumen diario de alertas por reason.
- [ ] Correr Señal 7.2 — verificar 0 filas (NO_TASK_1H post-fin de turno).
- [ ] Correr Señal 7.3 — identificar empleados recurrentes en Alert 4.
- [ ] Correr Señal 7.4 — ratio in_progress vs blocked en Alert 4.
- [ ] Correr Señal 7.5 — % reconocimiento del supervisor por alerta.
- [ ] Correr Señal 7.7 — distribución de cierres post-fin para calibrar grace.

## Árbol de decisión

```
¿Señal 1 >15% AND Señal 2 >10%?
  SÍ → Implementar TASK_SWITCH (fase 2 completa)
  NO ↓

¿Señal 4 >5/día?
  SÍ → Implementar TASK_SWITCH mínimo (solo DONE→START)
  NO ↓

¿Señal 3 pct_claude >30%?
  SÍ → Revisar regex locales, NO añadir más complejidad
  NO ↓

¿Señal 5 >20%?
  SÍ → Mejorar el texto del picker (UX), no TASK_SWITCH
  NO ↓

¿Señal 6 tiene patrones repetidos?
  SÍ → Añadir al DB keyword_dictionary o regex local
  NO → Dejar arquitectura actual, los fixes 1–5 son suficientes
```

---

## Señal 7 — Alertas al supervisor (Alerts 1–4)

**Contexto**: después del ajuste al Alert 2 (ventana de actividad + check de
fin de turno) y la introducción del Alert 4 (`OPEN_TASKS_SHIFT_END`),
necesitamos verificar que las 4 alertas disparan cuando deben y no más.

Código: `backend/src/cron/supervisorAlerts.js` — cron cada 15 min.

| Reason | Cuándo dispara | Env vars |
|--------|----------------|----------|
| `NO_CHECKIN_1H` | Turno empezó hace >N min y el empleado no hizo check-in. | `ALERT_NO_CHECKIN_MINUTES` (60) |
| `NO_TASK_1H` | Empleado con check-in pero sin actividad de tarea en los últimos N min, turno aún activo, con `planned`/`blocked` pendientes. | `ALERT_NO_TASK_MINUTES` (60), `ALERT_SHIFT_END_GRACE_MINUTES` (0) |
| `TASK_OVERTIME` | Tarea `in_progress` con tiempo transcurrido > `factor × standard_minutes`. | `ALERT_OVERTIME_FACTOR` (2) |
| `OPEN_TASKS_SHIFT_END` | Turno terminó hace >N min y el empleado dejó tareas `in_progress`/`blocked`. | `ALERT_OPEN_TASKS_END_GRACE_MINUTES` (15) |

### 7.1 Volumen diario por tipo de alerta

```sql
-- Alertas emitidas por día y razón (últimos 14 días)
SELECT work_date,
       reason,
       COUNT(*) AS cantidad,
       COUNT(DISTINCT employee_id) AS empleados_unicos
FROM app.supervisor_escalations
WHERE work_date >= CURRENT_DATE - 14
  AND reason IN ('NO_CHECKIN_1H', 'NO_TASK_1H', 'TASK_OVERTIME', 'OPEN_TASKS_SHIFT_END')
GROUP BY work_date, reason
ORDER BY work_date DESC, reason;
```

**Lectura esperada**: volúmenes estables día a día. Un pico súbito en
`NO_TASK_1H` o `OPEN_TASKS_SHIFT_END` indica cambio de patrón operativo,
un cron corriendo con grace incorrecto, o una migración de turnos.

### 7.2 Sospecha de falsos positivos en `NO_TASK_1H` post-fix

**Pregunta**: ¿sigue disparando después del fin de turno? (No debería con
el JOIN a `shift_templates` y el check `NOW() < end_time + grace`.)

```sql
-- NO_TASK_1H disparadas DESPUÉS del fin de turno del empleado.
-- Si devuelve filas, hay un bug en el filtro de end_time o la tz está mal.
SELECT esc.created_at,
       e.full_name,
       st.shift_code,
       st.end_time,
       esc.created_at::time AS alerted_at_time,
       (esc.created_at::time - st.end_time) AS tiempo_post_fin
FROM app.supervisor_escalations esc
JOIN app.employees e          ON e.employee_id = esc.employee_id
JOIN app.shift_assignments sa ON sa.employee_id = e.employee_id AND sa.work_date = esc.work_date
JOIN app.shift_templates   st ON st.shift_id  = sa.shift_id
WHERE esc.reason = 'NO_TASK_1H'
  AND esc.work_date >= CURRENT_DATE - 14
  AND esc.created_at::time > st.end_time
  AND st.end_time > st.start_time  -- excluir turnos nocturnos (lógica distinta)
ORDER BY esc.created_at DESC;
```

**Umbral**: 0 filas esperado. ≥1 fila → revisar timezone del servidor
Postgres vs la del cron Node (`NOW()` vs `CURRENT_DATE + end_time`).

### 7.3 Cuántos empleados dejan tareas sin cerrar (Alert 4)

```sql
-- Empleados que recurrentemente disparan OPEN_TASKS_SHIFT_END.
-- Candidatos a coaching o a revisar si sus tareas realmente deben cerrarse
-- manualmente o si el flujo de checkout debería auto-cerrarlas.
SELECT e.full_name,
       COUNT(*) AS veces_alertado,
       MIN(esc.work_date) AS primera,
       MAX(esc.work_date) AS ultima
FROM app.supervisor_escalations esc
JOIN app.employees e ON e.employee_id = esc.employee_id
WHERE esc.reason = 'OPEN_TASKS_SHIFT_END'
  AND esc.work_date >= CURRENT_DATE - 30
GROUP BY e.full_name
HAVING COUNT(*) >= 3
ORDER BY veces_alertado DESC;
```

**Acción**: si hay 3+ empleados con ≥5 alertas/mes, considerar:
- Recordatorio proactivo al empleado 5 min antes del fin de turno con sus
  tareas abiertas (nueva feature).
- Auto-close de `in_progress` al checkout con confirmación del empleado.

### 7.4 Composición de Alert 4: in_progress vs blocked

**Pregunta**: ¿las alertas son mayormente por olvido de cerrar
(in_progress) o por problemas reales (blocked)?

El texto del mensaje incluye ambos counts. Para extraer stats de DB:

```sql
-- Extraer cantidad de tareas abiertas al alertar.
-- Parse simple del mensaje (busca "Dejó N tareas").
SELECT work_date,
       COUNT(*) AS alertas,
       AVG(
         NULLIF(
           (regexp_match(inbound_text, 'Dejó (\d+) tarea'))[1]::int,
           0
         )
       ) AS promedio_tareas_abiertas,
       COUNT(*) FILTER (WHERE inbound_text ILIKE '%🚫 *Bloqueadas%') AS con_bloqueadas
FROM app.supervisor_escalations
WHERE reason = 'OPEN_TASKS_SHIFT_END'
  AND work_date >= CURRENT_DATE - 14
GROUP BY work_date
ORDER BY work_date DESC;
```

Si `con_bloqueadas / alertas` es alto (>50%), el problema real no es
"olvido de cerrar" sino tareas que se quedan bloqueadas sin resolución →
revisar el flujo `WAITING_BLOCK_REASON` y el seguimiento de bloqueadas.

### 7.5 Tiempo de reconocimiento del supervisor

```sql
-- ¿Cuánto tarda un supervisor en reconocer la alerta vs. ignorarla?
-- Útil para medir si el formato nuevo (más info contextual) mejora respuesta.
SELECT reason,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL) AS reconocidas,
       ROUND(
         100.0 * COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL)
         / NULLIF(COUNT(*), 0),
         1
       ) AS pct_reconocidas,
       AVG(
         EXTRACT(EPOCH FROM (acknowledged_at - created_at)) / 60
       ) FILTER (WHERE acknowledged_at IS NOT NULL) AS min_promedio_ack
FROM app.supervisor_escalations
WHERE work_date >= CURRENT_DATE - 14
GROUP BY reason
ORDER BY reason;
```

**Umbral**: `pct_reconocidas` <50% significa que el supervisor está
saturado o ignorando alertas → reducir volumen (subir thresholds) o
consolidar (ej. un resumen diario en vez de alertas individuales).

### 7.6 Alertas por turno

```sql
-- Ver si ciertos turnos concentran alertas (ej. turno nocturno con menor
-- supervisión vs diurno).
SELECT st.shift_code,
       esc.reason,
       COUNT(*) AS cantidad
FROM app.supervisor_escalations esc
JOIN app.employees e          ON e.employee_id = esc.employee_id
JOIN app.shift_assignments sa ON sa.employee_id = e.employee_id AND sa.work_date = esc.work_date
JOIN app.shift_templates   st ON st.shift_id  = sa.shift_id
WHERE esc.work_date >= CURRENT_DATE - 14
GROUP BY st.shift_code, esc.reason
ORDER BY st.shift_code, cantidad DESC;
```

### 7.7 Tuning de `ALERT_OPEN_TASKS_END_GRACE_MINUTES`

Si el default `15` min es muy corto, el empleado se siente "acosado".
Si es muy largo, el supervisor se entera tarde.

```sql
-- Ver cuánto tardan los empleados en cerrar sus últimas tareas después
-- del fin de turno (distribución). Ayuda a calibrar el grace.
SELECT
  WIDTH_BUCKET(
    EXTRACT(EPOCH FROM (ti.completed_at - (sa.work_date + st.end_time))) / 60,
    -30, 60, 9
  ) AS bucket,
  COUNT(*) AS tareas
FROM app.task_instances ti
JOIN app.shift_assignments sa ON sa.employee_id = ti.employee_id AND sa.work_date = ti.work_date
JOIN app.shift_templates   st ON st.shift_id  = sa.shift_id
WHERE ti.completed_at IS NOT NULL
  AND ti.work_date >= CURRENT_DATE - 30
  AND st.end_time > st.start_time
  AND ti.completed_at::time BETWEEN (st.end_time - INTERVAL '30 min')
                                AND (st.end_time + INTERVAL '60 min')
GROUP BY bucket
ORDER BY bucket;
```

Lectura: si la mayoría de cierres caen en los primeros 10 min post-fin,
`grace=15` está bien. Si se extienden a 20–25 min, subir a `20`.

---

## Migraciones relacionadas

- `migrations/016_waiting_switch_confirm_state.sql` — añade
  `WAITING_SWITCH_CONFIRM` (y `WAITING_LOCATION`, `WAITING_NEXT_TASK_CONFIRM`
  por si faltan) al enum `app.session_state`. **Correr antes** de desplegar
  los fixes 1–5 en producción.

## Cambios a `supervisorAlerts.js` (Señal 7)

Sin migración de schema. Solo requiere reiniciar el backend para que el
cron recoja los cambios.

- **Alert 2 (`NO_TASK_1H`)**: ahora JOIN con `shift_assignments` +
  `shift_templates` y filtra `NOW() < end_time + SHIFT_END_GRACE_MINUTES`.
  Evita falsos positivos post-turno.
- **Alert 2**: criterio de "actividad" expandido — tarea `in_progress`
  OR `last_update_at` reciente OR `completed_at` reciente. Evita falsos
  positivos durante transición entre rutinaria cerrada y ad-hoc nueva.
- **Alert 4 (`OPEN_TASKS_SHIFT_END`)**: NUEVA. Empleado con turno
  terminado y tareas `in_progress`/`blocked` sin cerrar.

**Nuevas env vars opcionales** (todas tienen default sensato):

| Variable | Default | Efecto |
|----------|---------|--------|
| `ALERT_SHIFT_END_GRACE_MINUTES` | `0` | Alert 2 deja de disparar este número de min después del fin de turno. `0` = estricto. |
| `ALERT_OPEN_TASKS_END_GRACE_MINUTES` | `15` | Alert 4 espera este número de min después del fin de turno antes de disparar. |

## Notas de despliegue

1. Ejecutar `migrations/016_waiting_switch_confirm_state.sql` en la DB de
   producción **antes** de reiniciar el backend con los fixes. El enum
   debe aceptar `WAITING_SWITCH_CONFIRM` o Fix #2 crasheará.
2. Reiniciar el backend.
3. Hacer una prueba manual del flujo desde Telegram:
   - Iniciar tarea A → "empiezo con la 1"
   - Intentar iniciar tarea B → "voy a hacer la 3"
   - Verificar que el bot pregunta: *pausar / terminar N / simultáneo / cancelar*
   - Responder "pausar" y verificar que la A queda en `planned` y la B en `in_progress`.
4. Programar recordatorio para revisar este documento en 14 días.
