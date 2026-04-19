-- ============================================================
-- Migration 006: Add WAITING_ADHOC_CONFIRM session state
-- Purpose: Confirmation step before creating ad-hoc tasks.
--          Employee can add description and photos before confirming.
-- ============================================================

ALTER TYPE app.session_state ADD VALUE IF NOT EXISTS 'WAITING_ADHOC_CONFIRM' AFTER 'WAITING_WRAPUP';
