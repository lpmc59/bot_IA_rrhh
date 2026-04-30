-- Migration 020: continued status + requires_mobile_ui flag + CONTINUED_TOMORROW update_type
--
-- Habilita 2 features nuevas:
--
-- (a) Tareas multi-día: status 'continued' marca una task_instance que el
--     técnico decidió pausar al final del turno para retomar mañana. Es
--     SEMÁNTICAMENTE distinto de 'blocked' (que requiere acción del
--     supervisor). Al marcar continued, el bot crea automáticamente una
--     nueva task_instance con work_date=mañana y mismo task_id.
--
--     Reportes de productividad pueden filtrar por:
--       - blocked  → tareas trabadas que requieren atención
--       - continued → trabajo legítimo que se extiende a otro día
--     Y la tarea madre (en app.tasks) NO se cierra hasta que la última
--     instance se marque 'done'.
--
-- (b) UI móvil para tickets externos (optel-redes NOC): el flag
--     requires_mobile_ui en app.tasks indica que al crear la
--     task_instance se debe generar un access_token automáticamente y
--     enviar el link /m/task/<token> al técnico. La página móvil
--     (task.html) muestra botones de acción rápida (start, traveling,
--     on_site, progress, blocked, done, continue-tomorrow, note, photo)
--     para que el técnico no dependa exclusivamente de Telegram.
--
-- Aditiva y backward-compatible: sin defaults agresivos, sin tocar filas
-- existentes. Tareas creadas antes de esta migración tienen
-- requires_mobile_ui=false y siguen funcionando como antes.

ALTER TYPE app.task_instance_status ADD VALUE IF NOT EXISTS 'continued';
ALTER TYPE app.task_update_type     ADD VALUE IF NOT EXISTS 'CONTINUED_TOMORROW';

ALTER TABLE app.tasks
  ADD COLUMN IF NOT EXISTS requires_mobile_ui boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN app.tasks.requires_mobile_ui IS
  'Si true: al crear task_instance se genera access_token automáticamente '
  'y el mensaje Telegram al empleado incluye link /m/task/<token>. '
  'Pensado para tickets de sistemas externos (optel-redes NOC) donde el '
  'técnico opera la tarea desde una pantalla móvil con botones de acción.';
