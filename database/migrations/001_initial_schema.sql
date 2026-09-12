-- Migration 001: Initial schema for workflow runs, jobs, and attempts

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'running' CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  command TEXT NOT NULL,
  image VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'created' CHECK (
    status IN (
      'created',
      'queued',
      'assigned',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
      'retrying'
    )
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  worker_id VARCHAR(255),
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  error TEXT,
  timeout_seconds INTEGER,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status VARCHAR(50) NOT NULL CHECK (
    status IN (
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out'
    )
  ),
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  CONSTRAINT unique_job_attempt UNIQUE (job_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_workflow_run_id ON jobs(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_job_attempts_job_id ON job_attempts(job_id);
