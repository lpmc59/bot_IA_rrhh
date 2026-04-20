-- Migration 017: External source tracking for tasks
-- Habilita que sistemas externos (ej. optel-redes NOC/Help-Desk) generen
-- tareas vía /api/external/tasks, con idempotencia por referencia externa.
-- 100% aditiva y backward-compatible: tareas existentes quedan con NULL
-- en estos campos y siguen funcionando igual.

ALTER TABLE app.tasks
  ADD COLUMN IF NOT EXISTS external_source text,
  ADD COLUMN IF NOT EXISTS external_ref    text,
  ADD COLUMN IF NOT EXISTS external_meta   jsonb;

COMMENT ON COLUMN app.tasks.external_source IS
  'Nombre del sistema externo que generó la tarea (ej. ''optel-redes''). NULL si fue creada desde el propio bot (flujo supervisor/ad-hoc).';
COMMENT ON COLUMN app.tasks.external_ref IS
  'Referencia/ID del ticket en el sistema externo. Único combinado con external_source para idempotencia de retries.';
COMMENT ON COLUMN app.tasks.external_meta IS
  'Metadata libre del sistema externo (código cliente, sede, incidente, URL, etc.). No se muestra al empleado salvo que se anexe vía endpoint de attachments.';

-- Unicidad + idempotencia: si el sistema externo reintenta con el mismo
-- ticket_id, findExternalTaskByRef retorna el task existente sin duplicar.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_tasks_external_ref
  ON app.tasks (external_source, external_ref)
  WHERE external_source IS NOT NULL AND external_ref IS NOT NULL;

-- Consultas tipo "todas las tareas de optel-redes activas":
CREATE INDEX IF NOT EXISTS idx_tasks_external_source
  ON app.tasks (external_source)
  WHERE external_source IS NOT NULL;
