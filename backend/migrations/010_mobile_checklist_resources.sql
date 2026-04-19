-- Migration 010: Task instance checklist, resources, and mobile access tokens
-- Enables copy-on-write from templates to instances + passwordless mobile web access

-- 1. Checklist por instancia (copiado desde task_checklist_items al iniciar tarea)
CREATE TABLE IF NOT EXISTS app.task_instance_checklist (
    instance_checklist_id uuid DEFAULT public.gen_random_uuid() PRIMARY KEY,
    instance_id uuid NOT NULL REFERENCES app.task_instances(instance_id) ON DELETE CASCADE,
    checklist_item_id uuid REFERENCES app.task_checklist_items(checklist_item_id) ON DELETE SET NULL,
    sort_order integer NOT NULL DEFAULT 1,
    title text NOT NULL,
    description text,
    help_text text,
    help_image_url text,
    help_video_url text,
    is_required boolean NOT NULL DEFAULT true,
    requires_photo boolean NOT NULL DEFAULT false,
    requires_note boolean NOT NULL DEFAULT false,
    estimated_minutes integer,
    -- Campos de instancia (estado del empleado):
    status text NOT NULL DEFAULT 'pending',
    completed_at timestamptz,
    completed_by uuid REFERENCES app.employees(employee_id) ON DELETE SET NULL,
    note_text text,
    photo_url text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT task_instance_checklist_sort_chk CHECK (sort_order >= 1),
    CONSTRAINT task_instance_checklist_status_chk CHECK (status IN ('pending', 'done', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_tic_instance
    ON app.task_instance_checklist (instance_id, sort_order);

-- 2. Recursos por instancia (copiado desde task_required_resources al iniciar tarea)
CREATE TABLE IF NOT EXISTS app.task_instance_resources (
    instance_resource_id uuid DEFAULT public.gen_random_uuid() PRIMARY KEY,
    instance_id uuid NOT NULL REFERENCES app.task_instances(instance_id) ON DELETE CASCADE,
    task_resource_id uuid REFERENCES app.task_required_resources(task_resource_id) ON DELETE SET NULL,
    sort_order integer NOT NULL DEFAULT 1,
    resource_type text NOT NULL,
    resource_name text NOT NULL,
    description text,
    quantity numeric(10,2),
    unit text,
    estimated_use_minutes integer,
    actual_use_minutes integer,
    is_required boolean NOT NULL DEFAULT true,
    acquisition text NOT NULL DEFAULT 'own',
    -- Campos de instancia:
    confirmed boolean NOT NULL DEFAULT false,
    confirmed_at timestamptz,
    confirmed_by uuid REFERENCES app.employees(employee_id) ON DELETE SET NULL,
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT task_instance_resources_sort_chk CHECK (sort_order >= 1),
    CONSTRAINT task_instance_resources_qty_chk CHECK (quantity IS NULL OR quantity >= 0),
    CONSTRAINT task_instance_resources_est_chk CHECK (estimated_use_minutes IS NULL OR estimated_use_minutes >= 0),
    CONSTRAINT task_instance_resources_act_chk CHECK (actual_use_minutes IS NULL OR actual_use_minutes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_tir_instance
    ON app.task_instance_resources (instance_id, sort_order);

-- 3. Tokens de acceso móvil (sin login, por instancia)
CREATE TABLE IF NOT EXISTS app.task_instance_access_tokens (
    token_id uuid DEFAULT public.gen_random_uuid() PRIMARY KEY,
    instance_id uuid NOT NULL REFERENCES app.task_instances(instance_id) ON DELETE CASCADE,
    employee_id uuid NOT NULL REFERENCES app.employees(employee_id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked boolean NOT NULL DEFAULT false,
    last_accessed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tiat_token
    ON app.task_instance_access_tokens (token);
CREATE INDEX IF NOT EXISTS idx_tiat_instance
    ON app.task_instance_access_tokens (instance_id);
