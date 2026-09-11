// Workflow definition -- parsed from YAML workflow files.

export interface StepDefinition {
  name?: string;
  run: string;
  timeout_seconds?: number;
}

export interface WorkflowDefinition {
  name: string;
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
