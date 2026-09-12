export interface RetryPolicy {
  max_attempts?: number;
  base_delay_seconds?: number;
  max_delay_seconds?: number;
  backoff_factor?: number;
  jitter?: boolean;
  retry_on_timeout?: boolean;
}

export interface ArtifactConfig {
  name?: string;
  paths?: string[];
  path?: string;
  retention_days?: number;
}

export interface StepDefinition {
  name?: string;
  run: string;
  image?: string;
  timeout_seconds?: number;
  retries?: number;
  retry?: RetryPolicy;
  artifacts?: string[] | ArtifactConfig;
}

export interface JobDefinition {
  name?: string;
  image?: string;
  steps?: StepDefinition[];
  run?: string;
  needs?: string[] | string;
  timeout_seconds?: number;
  retries?: number;
  retry?: RetryPolicy;
  artifacts?: string[] | ArtifactConfig;
  priority?: number;
  tags?: string[];
  env?: Record<string, string>;
}

export interface EventTriggerFilter {
  branches?: string[];
  types?: string[];
}

export type WorkflowTriggerConfig =
  | string
  | string[]
  | {
      push?: EventTriggerFilter | null;
      pull_request?: EventTriggerFilter | null;
      [event: string]: EventTriggerFilter | Record<string, unknown> | null | undefined;
    };

export interface WorkflowDefinition {
  name: string;
  on?: WorkflowTriggerConfig;
  image?: string;
  steps?: StepDefinition[];
  jobs?: Record<string, JobDefinition>;
  env?: Record<string, string>;
}

export interface NormalizedJobDefinition {
  id: string;
  name: string;
  image?: string;
  steps: StepDefinition[];
  needs: string[];
  timeout_seconds?: number;
  retries?: number;
  retry?: RetryPolicy;
  artifacts?: string[] | ArtifactConfig;
  priority?: number;
  tags?: string[];
  env?: Record<string, string>;
}

export interface NormalizedWorkflowDefinition {
  name: string;
  on?: WorkflowTriggerConfig;
  image?: string;
  jobs: Record<string, NormalizedJobDefinition>;
  topologicalOrder: string[];
  env?: Record<string, string>;
}

// Execution results -- produced by the runner after executing a workflow.

export type StepStatus = 'success' | 'failed' | 'skipped' | 'cancelled';
export type WorkflowStatus = 'success' | 'failed' | 'cancelled';

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
  repository_id?: string | null;
  trigger_event?: string | null;
  trigger_sender?: string | null;
  commit_sha?: string | null;
  commit_ref?: string | null;
  commit_message?: string | null;
}

export interface JobRecord {
  id: string;
  workflow_run_id: string;
  job_key?: string | null;
  needs?: string[];
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
  lease_token: string | null;
  lease_expires_at: string | null;
  lease_duration_seconds: number | null;
  retry_policy?: RetryPolicy | null;
  next_retry_at: string | null;
  artifacts?: string[] | ArtifactConfig | null;
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
  correlationId?: string;
  traceId?: string;
}

// Worker registration model (Milestone 7)

export type WorkerStatus = 'ready' | 'busy' | 'offline' | 'paused';

export interface WorkerRecord {
  id: string;
  name: string;
  status: WorkerStatus;
  address: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  registered_at: string;
  last_heartbeat_at: string;
  created_at: string;
  updated_at: string;
}

export interface RegisterWorkerRequest {
  id: string;
  name: string;
  address?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface WorkerHeartbeatRequest {
  status?: WorkerStatus;
}

// Lease models (Milestone 10)

export interface RenewLeaseRequest {
  lease_token: string;
  duration_seconds?: number;
}

export interface RenewLeaseResponse {
  job: JobRecord;
  lease_expires_at: string;
}

// Log streaming models (Milestone 13)

export type LogStream = 'stdout' | 'stderr';

export interface LogChunk {
  jobId: string;
  stream: LogStream;
  data: string;
  timestamp: string;
  attempt?: number;
}

export interface LogEndEvent {
  jobId: string;
  event: 'end';
  exitCode?: number | null;
  durationMs?: number;
}

export type LogEvent = LogChunk | LogEndEvent;

// Artifact storage models (Milestone 15)

export interface ArtifactRecord {
  id: string;
  job_id: string;
  workflow_run_id: string;
  name: string;
  path: string;
  size_bytes: number;
  mime_type: string | null;
  storage_path: string;
  checksum: string | null;
  created_at: string;
}

export interface CreateArtifactParams {
  jobId: string;
  workflowRunId: string;
  name: string;
  path: string;
  sizeBytes: number;
  mimeType?: string | null;
  storagePath: string;
  checksum?: string | null;
}

// Repository & Workflow Registration (Milestone 18)

export interface RepositoryRecord {
  id: string;
  name: string;
  url: string | null;
  default_branch: string;
  webhook_secret: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRepositoryParams {
  name: string;
  url?: string | null;
  default_branch?: string;
  webhook_secret?: string | null;
}

export interface RegisteredWorkflowRecord {
  id: string;
  repository_id: string;
  name: string;
  path: string;
  content: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateRegisteredWorkflowParams {
  repositoryId: string;
  name: string;
  path?: string;
  content: string;
  isActive?: boolean;
}

// GitHub Webhook Types (Milestone 18)

export interface GitHubPushPayload {
  ref?: string;
  before?: string;
  after?: string;
  deleted?: boolean;
  created?: boolean;
  repository?: {
    name?: string;
    full_name?: string;
    clone_url?: string;
    default_branch?: string;
  };
  pusher?: {
    name?: string;
    email?: string;
  };
  sender?: {
    login?: string;
  };
  head_commit?: {
    id?: string;
    message?: string;
    timestamp?: string;
    author?: {
      name?: string;
      email?: string;
    };
  };
}

export interface GitHubPullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: {
    title?: string;
    head?: {
      ref?: string;
      sha?: string;
    };
    base?: {
      ref?: string;
      sha?: string;
    };
  };
  repository?: {
    name?: string;
    full_name?: string;
  };
  sender?: {
    login?: string;
  };
}

export interface GitHubPingPayload {
  zen?: string;
  hook_id?: number;
  repository?: {
    name?: string;
    full_name?: string;
  };
}

export interface WebhookTriggerResult {
  event: string;
  repository: string;
  matchedWorkflows: number;
  runs: WorkflowRunRecord[];
  action?: string;
  ref?: string;
  commitSha?: string;
  message?: string;
}

// System Statistics (Milestone 19)

export interface SystemStats {
  runs: {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  };
  jobs: {
    total: number;
    created: number;
    queued: number;
    assigned: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    timed_out: number;
    retrying: number;
  };
  workers: {
    total: number;
    ready: number;
    busy: number;
    offline: number;
    paused: number;
  };
  repositories: {
    total: number;
  };
  artifacts: {
    total: number;
    totalBytes: number;
  };
}




