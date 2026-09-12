import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type {
  WorkflowDefinition,
  StepResult,
  WorkflowResult,
  StepStatus,
} from '@mini-ci/types';

import { runStepInDocker } from './docker-runner.js';

export interface ExecuteOptions {
  mode?: 'shell' | 'docker';
  shell?: string;
}

interface StepOutput {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

// -- Shell runner (Milestone 1) -----------------------------------------------

function killProcessTree(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Process may have already exited.
  }
}

function runStepShell(
  command: string,
  timeoutMs: number | undefined,
  shell: string | boolean,
): Promise<StepOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, [], {
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        killed = true;
        if (child.pid !== undefined) {
          killProcessTree(child.pid);
        } else {
          child.kill('SIGKILL');
        }
      }, timeoutMs);
    }

    child.on('error', (err: Error) => {
      if (timer) clearTimeout(timer);
      resolve({ exit_code: null, stdout, stderr, error: err.message });
    });

    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);

      if (killed) {
        resolve({
          exit_code: code,
          stdout,
          stderr,
          error: `Step timed out after ${timeoutMs}ms`,
        });
        return;
      }

      resolve({ exit_code: code, stdout, stderr });
    });
  });
}

// -- Workflow executor --------------------------------------------------------

export async function executeWorkflow(
  workflow: WorkflowDefinition,
  options: ExecuteOptions = {},
): Promise<WorkflowResult> {
  const mode = options.mode ?? (workflow.image ? 'docker' : 'shell');
  const workflowStart = new Date();
  const results: StepResult[] = [];
  let failed = false;

  // Create a temporary workspace for Docker mode.
  let workspaceDir: string | undefined;
  if (mode === 'docker') {
    workspaceDir = await mkdtemp(join(tmpdir(), 'mini-ci-'));
  }

  try {
    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i]!;
      const stepName = step.name ?? `Step ${i + 1}`;

      if (failed) {
        results.push({
          index: i,
          name: stepName,
          command: step.run,
          status: 'skipped',
          exit_code: null,
          stdout: '',
          stderr: '',
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: 0,
        });
        continue;
      }

      const stepStart = new Date();
      const timeoutMs = step.timeout_seconds ? step.timeout_seconds * 1000 : undefined;

      let result: StepOutput;

      if (mode === 'docker') {
        // Step-level image overrides workflow-level image.
        const image = step.image ?? workflow.image;
        if (!image) {
          result = {
            exit_code: null,
            stdout: '',
            stderr: '',
            error: 'No Docker image specified for step or workflow',
          };
        } else {
          result = await runStepInDocker(image, step.run, workspaceDir!, timeoutMs);
        }
      } else {
        result = await runStepShell(step.run, timeoutMs, options.shell ?? true);
      }

      const stepEnd = new Date();

      let status: StepStatus;
      if (result.error) {
        status = 'failed';
      } else if (result.exit_code === 0) {
        status = 'success';
      } else {
        status = 'failed';
      }

      const stepResult: StepResult = {
        index: i,
        name: stepName,
        command: step.run,
        status,
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        started_at: stepStart.toISOString(),
        finished_at: stepEnd.toISOString(),
        duration_ms: stepEnd.getTime() - stepStart.getTime(),
      };

      if (result.error) {
        stepResult.error = result.error;
      }

      results.push(stepResult);

      if (status === 'failed') {
        failed = true;
      }
    }
  } finally {
    // Clean up workspace directory.
    if (workspaceDir) {
      try {
        await rm(workspaceDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  const workflowEnd = new Date();

  return {
    workflow_name: workflow.name,
    status: failed ? 'failed' : 'success',
    steps: results,
    started_at: workflowStart.toISOString(),
    finished_at: workflowEnd.toISOString(),
    duration_ms: workflowEnd.getTime() - workflowStart.getTime(),
  };
}
