-- Supervisor assignment tokens for mobile task creation form
CREATE TABLE IF NOT EXISTS app.supervisor_assignment_tokens (
    token_id      uuid DEFAULT public.gen_random_uuid() PRIMARY KEY,
    supervisor_id uuid NOT NULL REFERENCES app.employees(employee_id),
    token         text NOT NULL UNIQUE,
    expires_at    timestamptz NOT NULL,
    used          boolean DEFAULT false,
    created_task_id uuid REFERENCES app.tasks(task_id),
    created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sat_token ON app.supervisor_assignment_tokens (token);
