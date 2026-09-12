-- Migration 003: Add lease tracking columns to jobs table

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_token VARCHAR(255);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_duration_seconds INTEGER DEFAULT 30;

CREATE INDEX IF NOT EXISTS idx_jobs_lease_expires_at ON jobs(lease_expires_at);
