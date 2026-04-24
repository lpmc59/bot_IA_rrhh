-- Migration 019: Estados de viaje para task_instances
--
-- Agrega `traveling` (en camino al sitio) y `on_site` (ya en el lugar pero
-- aún no empezó el trabajo). Útil para técnicos de campo — permite que
-- NOC / optel-redes vea el avance del ticket antes de que el trabajo real
-- comience, y medir tiempos de respuesta.
--
-- También se agregan los correspondientes update_types en task_updates
-- para mantener trazabilidad de transiciones:
--   - TRAVELING, ON_SITE (estados nuevos)
--   - CANCELED (que faltaba en el enum original — útil para log completo)
--
-- 100% aditiva. Tareas existentes no se afectan.
-- Reportes Python que hacen `WHERE status = 'in_progress'` no contarán
-- estos nuevos estados hasta que se actualicen (commit siguiente).

ALTER TYPE app.task_instance_status ADD VALUE IF NOT EXISTS 'traveling';
ALTER TYPE app.task_instance_status ADD VALUE IF NOT EXISTS 'on_site';

ALTER TYPE app.task_update_type ADD VALUE IF NOT EXISTS 'TRAVELING';
ALTER TYPE app.task_update_type ADD VALUE IF NOT EXISTS 'ON_SITE';
ALTER TYPE app.task_update_type ADD VALUE IF NOT EXISTS 'CANCELED';
