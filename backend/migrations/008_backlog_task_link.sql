-- ============================================================
-- Migration 008: Link task_instances to backlog tasks (tasks)
-- Purpose: Allow generateDailyTaskInstances to create daily
--          instances from long-term backlog tasks, with progress
--          propagation back to the parent task.
-- ============================================================

-- 0. Fix pre-existing bug: restartTask uses 'START' but it's not in the enum
--    (ALTER TYPE ADD VALUE cannot run inside a transaction in PG12)
ALTER TYPE app.task_update_type ADD VALUE IF NOT EXISTS 'START' AFTER 'NOTE';

-- 1. Add task_id column to task_instances (link to parent backlog task)
--    If task_id IS NOT NULL → instance came from tasks table
--    If template_id IS NOT NULL → instance came from shift_task_templates
--    Both NULL → ad-hoc task created by employee
ALTER TABLE app.task_instances ADD COLUMN IF NOT EXISTS task_id uuid;

ALTER TABLE app.task_instances
  ADD CONSTRAINT task_instances_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES app.tasks(task_id) ON DELETE SET NULL;

-- 2. Partial unique index: one instance per backlog task per employee per day
CREATE UNIQUE INDEX IF NOT EXISTS ux_ti_task
  ON app.task_instances (employee_id, work_date, task_id)
  WHERE task_id IS NOT NULL;

-- 3. Add progress_percent to tasks table (global progress of long-term task)
ALTER TABLE app.tasks ADD COLUMN IF NOT EXISTS progress_percent smallint DEFAULT 0;

DO $$
BEGIN
  ALTER TABLE app.tasks ADD CONSTRAINT tasks_progress_pct_chk
    CHECK (progress_percent >= 0 AND progress_percent <= 100);
EXCEPTION WHEN duplicate_object THEN
  NULL; -- constraint already exists
END $$;

-- 4. Index for efficient daily generation query
CREATE INDEX IF NOT EXISTS idx_tasks_employee_active
  ON app.tasks (employee_id, status)
  WHERE status NOT IN ('done', 'canceled');
