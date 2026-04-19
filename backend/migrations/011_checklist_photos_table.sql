-- Migration 011: Multiple photos per checklist item
-- Replaces single photo_url column with a dedicated photos table

CREATE TABLE IF NOT EXISTS app.task_instance_checklist_photos (
    photo_id    uuid DEFAULT public.gen_random_uuid() PRIMARY KEY,
    instance_checklist_id uuid NOT NULL
        REFERENCES app.task_instance_checklist(instance_checklist_id) ON DELETE CASCADE,
    file_url    text NOT NULL,
    file_name   text,
    file_size   integer,
    sort_order  integer NOT NULL DEFAULT 1,
    uploaded_by uuid REFERENCES app.employees(employee_id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticp_checklist
    ON app.task_instance_checklist_photos (instance_checklist_id, sort_order);

-- Migrate existing single photos (if any)
INSERT INTO app.task_instance_checklist_photos (instance_checklist_id, file_url, sort_order)
SELECT instance_checklist_id, photo_url, 1
FROM app.task_instance_checklist
WHERE photo_url IS NOT NULL;

-- Keep photo_url column for backwards compat (will hold first photo URL for quick access)
-- No need to drop it
