-- Migration 009: Add session states for supervisor shift inquiry flow
-- IMPORTANT: ALTER TYPE ADD VALUE cannot run inside a transaction in PG12.
-- Execute this file directly: psql -U talindadb_app -d talindadb -f 009_shift_inquiry_states.sql

ALTER TYPE app.session_state ADD VALUE IF NOT EXISTS 'WAITING_SHIFT_PICK';
ALTER TYPE app.session_state ADD VALUE IF NOT EXISTS 'WAITING_SHIFT_EMPLOYEE_PICK';
