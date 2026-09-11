import { spawn } from 'node:child_process';

import type {
  WorkflowDefinition,
  StepResult,
  WorkflowResult,
  StepStatus,
} from '@mini-ci/types';

interface ExecuteOptions {
  shell?: string;
}

const isWindows = process.platform === 'win32';

function killProcessTree(pid: number): void {
  if (isWindows) {
    // On Windows, SIGTERM does not propagate to child processes.
    // taskkill /T kills the entire process tree.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      // Kill the process group on Unix.
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Process may have already exited.
    }
  }
}

function runStep(
  command: string,
  timeoutMs: number | undefined,
  options: ExecuteOptions,
): Promise<{ exit_code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const useShell = options.shell ?? true;
    const spawnOptions: {
      shell: boolean | string;
      stdio: ['ignore', 'pipe', 'pipe'];
      detached?: boolean;
    } = {
      shell: useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    // On Unix, detach so we can kill the process group.
    if (!isWindows) {
      spawnOptions.detached = true;
    }

    let stdout = '';
    let stderr = '';
    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(command, [], spawnOptions);

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

export async function executeWorkflow(
  workflow: WorkflowDefinition,
  options: ExecuteOptions = {},
): Promise<WorkflowResult> {
  const workflowStart = new Date();
  const results: StepResult[] = [];
  let failed = false;

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
    const result = await runStep(step.run, timeoutMs, options);
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
