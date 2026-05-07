-- Migration 013: Local fixups for schema drift in LINE Harness OSS
--
-- Background: schema.sql + migrations 001–012 leave several tables missing
-- the line_account_id column even though the application code (e.g.
-- apps/worker/src/routes/webhook.ts, notifications.ts) queries it.
-- Without these columns the webhook handler throws:
--   D1_ERROR: no such column: line_account_id
--
-- Apply with:
--   npx wrangler d1 execute line-harness-test --remote \
--     --file=packages/db/migrations/013_local_fixups.sql

ALTER TABLE auto_replies ADD COLUMN line_account_id TEXT;
ALTER TABLE notification_rules ADD COLUMN line_account_id TEXT;
