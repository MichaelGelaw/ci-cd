-- Migration 006: Add job_key and needs columns to jobs table for multi-job dependencies

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS job_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS needs JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_jobs_workflow_run_job_key ON jobs(workflow_run_id, job_key);
