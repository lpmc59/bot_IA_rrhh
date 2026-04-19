-- Add telegram_id column to employees for Telegram bot identification
ALTER TABLE app.employees ADD COLUMN IF NOT EXISTS telegram_id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_telegram_id
    ON app.employees (telegram_id) WHERE telegram_id IS NOT NULL;
