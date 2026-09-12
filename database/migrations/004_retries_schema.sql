-- Migration 004: Add retry policy and next retry timestamp to jobs table

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS retry_policy JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_jobs_next_retry_at ON jobs(next_retry_at);
