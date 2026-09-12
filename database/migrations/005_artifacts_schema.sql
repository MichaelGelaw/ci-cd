-- Migration 005: Add artifacts table and artifacts configuration column to jobs table

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS artifacts JSONB;

CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  path TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  mime_type VARCHAR(128),
  storage_path TEXT NOT NULL,
  checksum VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_artifacts_job_id ON artifacts(job_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_workflow_run_id ON artifacts(workflow_run_id);