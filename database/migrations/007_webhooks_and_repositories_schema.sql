-- Migration 007: Repositories, registered workflows, and webhook trigger metadata

CREATE TABLE IF NOT EXISTS repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  url VARCHAR(1024),
  default_branch VARCHAR(255) NOT NULL DEFAULT 'main',
  webhook_secret VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS registered_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  path VARCHAR(255) NOT NULL DEFAULT '.mini-ci/workflow.yml',
  content TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_repo_workflow UNIQUE (repository_id, name)
);

ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS repository_id UUID REFERENCES repositories(id) ON DELETE SET NULL;
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS trigger_event VARCHAR(100);
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS trigger_sender VARCHAR(255);
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS commit_sha VARCHAR(100);
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS commit_ref VARCHAR(255);
ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS commit_message TEXT;

CREATE INDEX IF NOT EXISTS idx_repositories_name ON repositories(name);
CREATE INDEX IF NOT EXISTS idx_registered_workflows_repo ON registered_workflows(repository_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_repo ON workflow_runs(repository_id);
