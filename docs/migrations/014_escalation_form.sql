-- Migration 014: Supervisor auditor escalation form fields
-- Adds fields for escalation follow-up form used by supervisor_auditor role
-- Also creates token table for secure mobile form access

-- 1. New columns in supervisor_escalations
ALTER TABLE app.supervisor_escalations
  ADD COLUMN IF NOT EXISTS requires_form      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS contacto_empleado  boolean,
  ADD COLUMN IF NOT EXISTS instrucciones_dadas text,
  ADD COLUMN IF NOT EXISTS nota_adicional     text,
  ADD COLUMN IF NOT EXISTS resuelto           text DEFAULT 'pendiente'
    CHECK (resuelto IN ('si', 'no', 'pendiente')),
  ADD COLUMN IF NOT EXISTS form_opened_at     timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at        timestamptz;

-- 2. Token table for escalation form access
CREATE TABLE IF NOT EXISTS app.escalation_access_tokens (
    token_id       uuid DEFAULT public.gen_random_uuid() PRIMARY KEY,
    escalation_id  uuid NOT NULL REFERENCES app.supervisor_escalations(escalation_id) ON DELETE CASCADE,
    supervisor_id  uuid NOT NULL REFERENCES app.employees(employee_id),
    token          text NOT NULL UNIQUE,
    expires_at     timestamptz NOT NULL,
    revoked        boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_eat_token ON app.escalation_access_tokens(token);
CREATE INDEX IF NOT EXISTS idx_eat_escalation ON app.escalation_access_tokens(escalation_id);

-- 3. Index for querying pending escalation forms
CREATE INDEX IF NOT EXISTS idx_escalations_form_pending
  ON app.supervisor_escalations(supervisor_id, requires_form, resuelto)
  WHERE requires_form = true;
