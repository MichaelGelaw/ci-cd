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

import {
  createWorkflowRun,
  updateWorkflowRun,
  createJob,
  updateJobStatus,
  calculateRetryDelay,
} from '@mini-ci/db';
import { runStepInDocker } from './docker-runner.js';
import { normalizeWorkflow } from './parser.js';

export interface ExecuteOptions {
  mode?: 'shell' | 'docker';
  shell?: string;
  persist?: boolean;
  signal?: AbortSignal;
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
    if (process.platform === 'win32') {
      process.kill(pid, 'SIGKILL');
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Process may have already exited.
  }
}

function runStepShell(
  command: string,
  timeoutMs: number | undefined,
  shell: string | boolean,
  signal?: AbortSignal,
): Promise<StepOutput> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (signal?.aborted) {
      resolve({
        exit_code: null,
        stdout: '',
        stderr: '',
        error: 'Cancelled by user request',
      });
      return;
    }

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

    const onAbort = () => {
      cancelled = true;
      if (child.pid !== undefined) {
        killProcessTree(child.pid);
      } else {
        child.kill('SIGKILL');
      }
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

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
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ exit_code: null, stdout, stderr, error: err.message });
    });

    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);

      if (cancelled || signal?.aborted) {
        resolve({
          exit_code: code,
          stdout,
          stderr,
          error: 'Cancelled by user request',
        });
        return;
      }

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

async function executeMultiJobWorkflow(
  workflow: WorkflowDefinition,
  options: ExecuteOptions = {},
): Promise<WorkflowResult> {
  const mode = options.mode ?? (workflow.image ? 'docker' : 'shell');
  const workflowStart = new Date();
  const results: StepResult[] = [];
  let failed = false;
  let cancelled = false;

  const normalized = normalizeWorkflow(workflow);
  let dbRunId: string | null = null;
  const dbJobMap = new Map<string, string>();

  if (options.persist) {
    const runRecord = await createWorkflowRun(workflow.name, 'running');
    dbRunId = runRecord.id;

    for (const jobKey of normalized.topologicalOrder) {
      const job = normalized.jobs[jobKey]!;
      const retryPolicy =
        job.retry ??
        (job.retries !== undefined ? { max_attempts: job.retries + 1 } : undefined);
      const command = job.steps.map((s) => s.run).join('\n');
      const image = job.image ?? (mode === 'docker' ? workflow.image : undefined);

      const jobRecord = await createJob({
        workflowRunId: dbRunId,
        jobKey,
        needs: job.needs,
        name: job.name,
        command,
        image: image ?? null,
        timeoutSeconds: job.timeout_seconds ?? null,
        priority: job.priority ?? 0,
        status: 'created',
        retryPolicy,
        artifacts: job.artifacts,
      });
      dbJobMap.set(jobKey, jobRecord.id);
    }
  }

  let workspaceDir: string | undefined;
  if (mode === 'docker') {
    workspaceDir = await mkdtemp(join(tmpdir(), 'mini-ci-'));
  }

  const jobStatusMap = new Map<string, 'success' | 'failed' | 'skipped' | 'cancelled'>();

  try {
    for (const jobKey of normalized.topologicalOrder) {
      const job = normalized.jobs[jobKey]!;
      const dbJobId = dbJobMap.get(jobKey);

      if (cancelled || options.signal?.aborted) {
        cancelled = true;
        jobStatusMap.set(jobKey, 'cancelled');
        if (dbJobId) {
          try {
            await updateJobStatus(dbJobId, 'queued');
            await updateJobStatus(dbJobId, 'cancelled', {
              error: 'Cancelled by user request',
            });
          } catch {}
        }
        for (let si = 0; si < job.steps.length; si++) {
          const step = job.steps[si]!;
          results.push({
            index: results.length,
            name: `${job.name} - ${step.name ?? `Step ${si + 1}`}`,
            command: step.run,
            status: 'cancelled',
            exit_code: null,
            stdout: '',
            stderr: '',
            error: 'Cancelled by user request',
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: 0,
          });
        }
        continue;
      }

      const failedDep = job.needs.find((dep) => jobStatusMap.get(dep) !== 'success');
      if (failedDep) {
        jobStatusMap.set(jobKey, 'skipped');
        if (dbJobId) {
          try {
            await updateJobStatus(dbJobId, 'queued');
            await updateJobStatus(dbJobId, 'cancelled', {
              error: `Skipped because dependency "${failedDep}" did not succeed`,
            });
          } catch {}
        }
        for (let si = 0; si < job.steps.length; si++) {
          const step = job.steps[si]!;
          results.push({
            index: results.length,
            name: `${job.name} - ${step.name ?? `Step ${si + 1}`}`,
            command: step.run,
            status: 'skipped',
            exit_code: null,
            stdout: '',
            stderr: '',
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: 0,
          });
        }
        continue;
      }

      if (dbJobId) {
        try {
          await updateJobStatus(dbJobId, 'queued');
          await updateJobStatus(dbJobId, 'assigned');
        } catch {}
      }

      let jobFailed = false;
      for (let si = 0; si < job.steps.length; si++) {
        const step = job.steps[si]!;
        const stepName = `${job.name} - ${step.name ?? `Step ${si + 1}`}`;

        if (cancelled || options.signal?.aborted) {
          cancelled = true;
          jobFailed = true;
          results.push({
            index: results.length,
            name: stepName,
            command: step.run,
            status: 'cancelled',
            exit_code: null,
            stdout: '',
            stderr: '',
            error: 'Cancelled by user request',
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            duration_ms: 0,
          });
          continue;
        }

        if (jobFailed) {
          results.push({
            index: results.length,
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

        const retryPolicy =
          step.retry ??
          job.retry ??
          (step.retries !== undefined
            ? { max_attempts: step.retries + 1 }
            : job.retries !== undefined
              ? { max_attempts: job.retries + 1 }
              : undefined);
        const maxAttempts = retryPolicy?.max_attempts ?? 1;

        let result!: StepOutput;
        let stepStart!: Date;
        let stepEnd!: Date;
        let status!: StepStatus;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (attempt > 1) {
            const delaySeconds = calculateRetryDelay(attempt - 1, retryPolicy);
            if (delaySeconds > 0) {
              await new Promise((r) => setTimeout(r, Math.min(delaySeconds * 1000, 5000)));
            }
          }

          stepStart = new Date();
          const timeoutMs = (step.timeout_seconds ?? job.timeout_seconds)
            ? (step.timeout_seconds ?? job.timeout_seconds)! * 1000
            : undefined;

          if (dbJobId && attempt === 1 && si === 0) {
            try {
              await updateJobStatus(dbJobId, 'running', { startedAt: stepStart });
            } catch {}
          }

          if (mode === 'docker') {
            const image = step.image ?? job.image ?? workflow.image;
            if (!image) {
              result = {
                exit_code: null,
                stdout: '',
                stderr: '',
                error: 'No Docker image specified for step or workflow',
              };
            } else {
              result = await runStepInDocker(
                image,
                step.run,
                workspaceDir!,
                timeoutMs,
                options.signal,
              );
            }
          } else {
            result = await runStepShell(
              step.run,
              timeoutMs,
              options.shell ?? true,
              options.signal,
            );
          }

          stepEnd = new Date();

          if (result.error === 'Cancelled by user request' || options.signal?.aborted) {
            status = 'cancelled';
            cancelled = true;
          } else if (result.error) {
            status = 'failed';
          } else if (result.exit_code === 0) {
            status = 'success';
          } else {
            status = 'failed';
          }

          if (status === 'success' || status === 'cancelled') {
            break;
          }

          if (attempt < maxAttempts && dbJobId) {
            try {
              await updateJobStatus(dbJobId, 'failed', {
                exitCode: result.exit_code,
                stdout: result.stdout,
                stderr: result.stderr,
                error: result.error ?? null,
              });
              await updateJobStatus(dbJobId, 'retrying');
            } catch {}
          }
        }

        if (status !== 'success') {
          jobFailed = true;
          failed = true;
        }

        results.push({
          index: results.length,
          name: stepName,
          command: step.run,
          status,
          exit_code: result.exit_code,
          stdout: result.stdout,
          stderr: result.stderr,
          error: result.error,
          started_at: stepStart.toISOString(),
          finished_at: stepEnd.toISOString(),
          duration_ms: stepEnd.getTime() - stepStart.getTime(),
        });
      }

      if (jobFailed) {
        jobStatusMap.set(jobKey, cancelled ? 'cancelled' : 'failed');
        if (dbJobId) {
          try {
            await updateJobStatus(dbJobId, cancelled ? 'cancelled' : 'failed');
          } catch {}
        }
      } else {
        jobStatusMap.set(jobKey, 'success');
        if (dbJobId) {
          try {
            await updateJobStatus(dbJobId, 'succeeded');
          } catch {}
        }
      }
    }
  } finally {
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const workflowEnd = new Date();
  const durationMs = workflowEnd.getTime() - workflowStart.getTime();

  let finalStatus: 'success' | 'failed' | 'cancelled';
  if (cancelled) {
    finalStatus = 'cancelled';
  } else if (failed) {
    finalStatus = 'failed';
  } else {
    finalStatus = 'success';
  }

  if (options.persist && dbRunId) {
    await updateWorkflowRun(dbRunId, {
      status: finalStatus === 'cancelled' ? 'cancelled' : finalStatus === 'failed' ? 'failed' : 'succeeded',
      finished_at: workflowEnd.toISOString(),
      duration_ms: durationMs,
      error: cancelled
        ? 'Workflow was cancelled'
        : failed
          ? 'One or more jobs failed'
          : null,
    });
  }

  return {
    workflow_name: workflow.name,
    status: finalStatus,
    steps: results,
    started_at: workflowStart.toISOString(),
    finished_at: workflowEnd.toISOString(),
    duration_ms: durationMs,
  };
}

// -- Workflow executor --------------------------------------------------------

export async function executeWorkflow(
  workflow: WorkflowDefinition,
  options: ExecuteOptions = {},
): Promise<WorkflowResult> {
  if (workflow.jobs && Object.keys(workflow.jobs).length > 0) {
    return executeMultiJobWorkflow(workflow, options);
  }

  const mode = options.mode ?? (workflow.image ? 'docker' : 'shell');
  const steps = workflow.steps ?? [];
  const workflowStart = new Date();
  const results: StepResult[] = [];
  let failed = false;
  let cancelled = false;

  let dbRunId: string | null = null;
  const dbJobIds: (string | null)[] = [];

  if (options.persist) {
    const runRecord = await createWorkflowRun(workflow.name, 'running');
    dbRunId = runRecord.id;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const stepName = step.name ?? `Step ${i + 1}`;
      const image = step.image ?? (mode === 'docker' ? workflow.image : undefined);

      const retryPolicy = step.retry ?? (step.retries !== undefined ? { max_attempts: step.retries + 1 } : undefined);
      const jobRecord = await createJob({
        workflowRunId: dbRunId,
        name: stepName,
        command: step.run,
        image: image ?? null,
        timeoutSeconds: step.timeout_seconds ?? null,
        status: 'created',
        retryPolicy,
        artifacts: step.artifacts,
      });
      dbJobIds.push(jobRecord.id);
    }
  }

  // Create a temporary workspace for Docker mode.
  let workspaceDir: string | undefined;
  if (mode === 'docker') {
    workspaceDir = await mkdtemp(join(tmpdir(), 'mini-ci-'));
  }

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const stepName = step.name ?? `Step ${i + 1}`;
      const dbJobId = dbJobIds[i];

      if (cancelled || options.signal?.aborted) {
        cancelled = true;
        if (dbJobId) {
          try {
            await updateJobStatus(dbJobId, 'queued');
            await updateJobStatus(dbJobId, 'cancelled', {
              error: 'Cancelled by user request',
            });
          } catch {
            // Best-effort status update
          }
        }

        results.push({
          index: i,
          name: stepName,
          command: step.run,
          status: 'cancelled',
          exit_code: null,
          stdout: '',
          stderr: '',
          error: 'Cancelled by user request',
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          duration_ms: 0,
        });
        continue;
      }

      if (failed) {
        if (dbJobId) {
          // In the state machine: created -> queued -> assigned -> running -> cancelled
          // To cleanly represent skipped jobs that never started, we transition created -> queued -> cancelled
          // or record cancellation error directly
          try {
            await updateJobStatus(dbJobId, 'queued');
            await updateJobStatus(dbJobId, 'cancelled', {
              error: 'Skipped due to previous step failure',
            });
          } catch {
            // Best-effort status update
          }
        }

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

      const retryPolicy = step.retry ?? (step.retries !== undefined ? { max_attempts: step.retries + 1 } : undefined);
      const maxAttempts = retryPolicy?.max_attempts ?? 1;

      let result!: StepOutput;
      let stepStart!: Date;
      let stepEnd!: Date;
      let status!: StepStatus;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
          const delaySeconds = calculateRetryDelay(attempt - 1, retryPolicy);
          if (delaySeconds > 0) {
            await new Promise((r) => setTimeout(r, Math.min(delaySeconds * 1000, 5000)));
          }
        }

        stepStart = new Date();
        const timeoutMs = step.timeout_seconds ? step.timeout_seconds * 1000 : undefined;

        if (dbJobId) {
          if (attempt === 1) {
            await updateJobStatus(dbJobId, 'queued');
            await updateJobStatus(dbJobId, 'assigned');
          }
          await updateJobStatus(dbJobId, 'running', { startedAt: stepStart });
        }

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
            result = await runStepInDocker(image, step.run, workspaceDir!, timeoutMs, options.signal);
          }
        } else {
          result = await runStepShell(step.run, timeoutMs, options.shell ?? true, options.signal);
        }

        stepEnd = new Date();

        if (result.error === 'Cancelled by user request' || options.signal?.aborted) {
          status = 'cancelled';
          cancelled = true;
        } else if (result.error) {
          status = 'failed';
        } else if (result.exit_code === 0) {
          status = 'success';
        } else {
          status = 'failed';
        }

        if (status === 'success' || status === 'cancelled') {
          break;
        }

        if (attempt < maxAttempts && dbJobId) {
          await updateJobStatus(dbJobId, 'failed', {
            exitCode: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.error ?? null,
          });
          await updateJobStatus(dbJobId, 'retrying');
          await updateJobStatus(dbJobId, 'queued');
          await updateJobStatus(dbJobId, 'assigned');
        }
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

      if (dbJobId) {
        const targetStatus = status === 'success' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed';
        await updateJobStatus(dbJobId, targetStatus, {
          exitCode: result.exit_code,
          stdout: result.stdout,
          stderr: result.stderr,
          error: result.error ?? null,
          finishedAt: stepEnd,
          durationMs: stepResult.duration_ms,
        });
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
  const totalDurationMs = workflowEnd.getTime() - workflowStart.getTime();

  if (dbRunId) {
    await updateWorkflowRun(dbRunId, {
      status: cancelled ? 'cancelled' : failed ? 'failed' : 'succeeded',
      finished_at: workflowEnd,
      duration_ms: totalDurationMs,
      error: cancelled ? 'Workflow cancelled by user request' : failed ? 'One or more steps failed' : null,
    });
  }

  return {
    workflow_name: workflow.name,
    status: cancelled ? 'cancelled' : failed ? 'failed' : 'success',
    steps: results,
    started_at: workflowStart.toISOString(),
    finished_at: workflowEnd.toISOString(),
    duration_ms: totalDurationMs,
  };
}
