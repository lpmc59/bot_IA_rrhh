-- Migration 016: Añadir estado WAITING_SWITCH_CONFIRM al enum app.session_state
--
-- Contexto: Fix #2 del análisis de bugs del flujo de conversación.
-- Cuando un empleado intenta iniciar una tarea nueva teniendo otra(s) en
-- progreso, handleTaskStart ahora pregunta qué hacer con la(s) actual(es):
--   pausar / terminar N / simultáneo / cancelar
-- Ese estado intermedio se llama WAITING_SWITCH_CONFIRM y debe existir en
-- el enum app.session_state para que updateSessionState no falle.
--
-- También aseguramos WAITING_LOCATION y WAITING_NEXT_TASK_CONFIRM, que son
-- estados usados por features previas (validación de ubicación en check-in
-- y confirmación de próxima tarea) pero que podrían no haber sido añadidos
-- al enum vía migración versionada.
--
-- Nota: ALTER TYPE ... ADD VALUE no puede ejecutarse dentro de un bloque
-- transaccional, por eso NO usamos BEGIN/COMMIT en este archivo.

ALTER TYPE app.session_state ADD VALUE IF NOT EXISTS 'WAITING_SWITCH_CONFIRM';
ALTER TYPE app.session_state ADD VALUE IF NOT EXISTS 'WAITING_LOCATION';
ALTER TYPE app.session_state ADD VALUE IF NOT EXISTS 'WAITING_NEXT_TASK_CONFIRM';
