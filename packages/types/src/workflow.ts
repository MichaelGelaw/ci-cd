// Workflow definition -- parsed from YAML workflow files.

export interface StepDefinition {
  name?: string;
  run: string;
  image?: string;
  timeout_seconds?: number;
}

export interface WorkflowDefinition {
  name: string;
  image?: string;
  steps: StepDefinition[];
}

// Execution results -- produced by the runner after executing a workflow.

export type StepStatus = 'success' | 'failed' | 'skipped';
export type WorkflowStatus = 'success' | 'failed';

export interface StepResult {
  index: number;
  name: string;
  command: string;
  status: StepStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  error?: string;
}

export interface WorkflowResult {
  workflow_name: string;
  status: WorkflowStatus;
  steps: StepResult[];
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

// Durable database state models (Milestone 3)

export type JobStatus =
  | 'created'
  | 'queued'
  | 'assigned'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'retrying';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface WorkflowRunRecord {
  id: string;
  workflow_name: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

export interface JobRecord {
  id: string;
  workflow_run_id: string;
  name: string;
  command: string;
  image: string | null;
  status: JobStatus;
  priority: number;
  attempt: number;
  max_attempts: number;
  worker_id: string | null;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  timeout_seconds: number | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface JobAttemptRecord {
  id: string;
  job_id: string;
  attempt_number: number;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

// Queue message model (Milestone 5)

export interface JobQueueMessage {
  jobId: string;
  workflowRunId: string;
  queuedAt: string;
  attempt: number;
}

