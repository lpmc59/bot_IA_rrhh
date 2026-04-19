-- ============================================================
-- Migration 005: Add instance_id to attachments table
-- Purpose: Attachments should link to task_instances (daily work)
--          instead of tasks (backlog). Keep task_id for future
--          backlog-level attachments.
-- ============================================================

BEGIN;

-- 1. Add instance_id column (nullable, since not all attachments may have one)
ALTER TABLE app.attachments
  ADD COLUMN IF NOT EXISTS instance_id uuid;

-- 2. FK to task_instances — SET NULL on delete so we don't lose the file
ALTER TABLE app.attachments
  ADD CONSTRAINT attachments_instance_id_fkey
  FOREIGN KEY (instance_id)
  REFERENCES app.task_instances(instance_id)
  ON DELETE SET NULL;

-- 3. Migrate existing data:
--    Currently task_id actually stores instance_id values (from webhook.js line 123).
--    Move those values to instance_id and clean task_id.
UPDATE app.attachments a
   SET instance_id = a.task_id,
       task_id     = NULL
 WHERE a.task_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM app.task_instances ti
      WHERE ti.instance_id = a.task_id
   );

-- 4. Index for efficient lookups by instance
CREATE INDEX IF NOT EXISTS idx_attachments_instance
  ON app.attachments(instance_id);

-- 5. Composite index: employee + date (useful for "show my photos today")
CREATE INDEX IF NOT EXISTS idx_attachments_employee_date
  ON app.attachments(employee_id, created_at);

COMMIT;
