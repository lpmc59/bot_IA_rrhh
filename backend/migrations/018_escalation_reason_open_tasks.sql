-- Migration 018: Add OPEN_TASKS_SHIFT_END to escalation_reason enum
--
-- Alert 4 (introducido junto con el fix del cron supervisorAlerts.js) inserta
-- en app.supervisor_escalations con reason='OPEN_TASKS_SHIFT_END', pero ese
-- valor no estaba en el enum app.escalation_reason. Resultado observado en
-- producción (Hetzner, abr-2026):
--
--   "Supervisor alert sub-task failed"
--   {"err":"invalid input value for enum escalation_reason:
--          \"OPEN_TASKS_SHIFT_END\""}
--
-- Esta migración es aditiva y segura: ADD VALUE IF NOT EXISTS no afecta a
-- filas ni índices existentes.
--
-- También agrega POST_CHECKOUT_ACTION defensivamente (se usa en
-- messageService.js al detectar interacción posterior al checkout).
-- Si ya existe, el IF NOT EXISTS lo ignora.

ALTER TYPE app.escalation_reason ADD VALUE IF NOT EXISTS 'OPEN_TASKS_SHIFT_END';
ALTER TYPE app.escalation_reason ADD VALUE IF NOT EXISTS 'POST_CHECKOUT_ACTION';
