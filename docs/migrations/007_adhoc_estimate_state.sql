-- ============================================================
-- Migration 007: Add WAITING_ADHOC_ESTIMATE session state
-- Purpose: After creating an ad-hoc task, ask the employee
--          how long they estimate it will take.
--          If they don't answer, default 30 min is kept.
-- ============================================================

ALTER TYPE app.session_state ADD VALUE IF NOT EXISTS 'WAITING_ADHOC_ESTIMATE' AFTER 'WAITING_ADHOC_CONFIRM';
