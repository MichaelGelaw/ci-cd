import type {
  JobRecord,
  JobAttemptRecord,
  JobStatus,
  RenewLeaseRequest,
  RenewLeaseResponse,
} from '@mini-ci/types';
import {
  getJob,
  updateJobStatus,
  getJobAttempts,
  getJobsByWorkflowRun,
  updateWorkflowRun,
  recordJobAttempt,
  renewJobLease,
  findExpiredLeases,
  findDueRetryingJobs,
  requeueJobForRetry,
  calculateRetryDelay,
  isFailureRetryable,
  findRecoverableJobs,
  recoverJob,
  recoverStaleJobs,
  LeaseConflictError,
} from '@mini-ci/db';
import type {
  FindRecoverableJobsOptions,
  RecoverJobOptions,
  RecoverJobResult,
} from '@mini-ci/db';
import { enqueueJob } from '@mini-ci/queue';



export async function getJobDetails(jobId: string): Promise<JobRecord | null> {
  return getJob(jobId);
}

export async function cancelJob(jobId: string): Promise<JobRecord> {
  const existing = await getJob(jobId);
  if (!existing) {
    throw new Error(`Job ${jobId} not found`);
  }

  return updateJobStatus(jobId, 'cancelled', {
    error: 'Cancelled by user request via API',
  });
}

export async function updateJobExecutionStatus(
  jobId: string,
  params: {
    status: JobStatus;
    workerId?: string;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string | null;
    durationMs?: number | null;
  },
): Promise<JobRecord> {
  const existing = await getJob(jobId);
  if (!existing) {
    throw new Error(`Job ${jobId} not found`);
  }

  const updates: Parameters<typeof updateJobStatus>[2] = {
    exitCode: params.exitCode,
    stdout: params.stdout,
    stderr: params.stderr,
    error: params.error,
    workerId: params.workerId,
    durationMs: params.durationMs,
  };

  if (params.status === 'running') {
    updates.startedAt = new Date();
  } else if (params.status === 'succeeded' || params.status === 'failed' || params.status === 'cancelled' || params.status === 'timed_out') {
    updates.finishedAt = new Date();
  }

  // Check if job failure is eligible for retry
  if (params.status === 'failed' || params.status === 'timed_out') {
    const isRetryable =
      existing.attempt < existing.max_attempts &&
      isFailureRetryable(params.status, existing.retry_policy);

    if (isRetryable) {
      const delaySeconds = calculateRetryDelay(existing.attempt, existing.retry_policy);
      const finishedAt = new Date();

      // Record this attempt before transitioning
      try {
        await recordJobAttempt({
          jobId: existing.id,
          attemptNumber: existing.attempt,
          status: params.status,
          exitCode: params.exitCode,
          stdout: params.stdout,
          stderr: params.stderr,
          error: params.error,
          durationMs: params.durationMs,
          startedAt: existing.started_at ?? undefined,
          finishedAt,
        });
      } catch {
        // Best-effort attempt recording
      }

      // Legal state transition: running -> failed/timed_out -> retrying
      await updateJobStatus(jobId, params.status, {
        exitCode: params.exitCode,
        stdout: params.stdout,
        stderr: params.stderr,
        error: params.error,
        durationMs: params.durationMs,
        finishedAt,
      });

      const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);
      const retryingJob = await updateJobStatus(jobId, 'retrying', {
        nextRetryAt,
      });

      return retryingJob;
    }
  }

  const updatedJob = await updateJobStatus(jobId, params.status, updates);

  // If entering terminal or running status, record attempt
  if (params.status === 'running' || params.status === 'succeeded' || params.status === 'failed' || params.status === 'timed_out') {
    try {
      await recordJobAttempt({
        jobId: updatedJob.id,
        attemptNumber: updatedJob.attempt,
        status: params.status,
        exitCode: params.exitCode,
        stdout: params.stdout,
        stderr: params.stderr,
        error: params.error,
        durationMs: params.durationMs,
        startedAt: updatedJob.started_at ?? undefined,
        finishedAt: updatedJob.finished_at ?? undefined,
      });
    } catch {
      // Best-effort attempt recording
    }
  }

  // Check if all jobs for the workflow run have completed
  if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(params.status)) {
    const siblingJobs = await getJobsByWorkflowRun(updatedJob.workflow_run_id);
    const allTerminal = siblingJobs.every((j) =>
      ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(j.status),
    );

    if (allTerminal) {
      const anyFailed = siblingJobs.some((j) => j.status === 'failed' || j.status === 'cancelled' || j.status === 'timed_out');
      const totalDuration = siblingJobs.reduce((acc, j) => acc + (j.duration_ms ?? 0), 0);
      await updateWorkflowRun(updatedJob.workflow_run_id, {
        status: anyFailed ? 'failed' : 'succeeded',
        finished_at: new Date(),
        duration_ms: totalDuration,
        error: anyFailed ? 'One or more jobs failed, timed out, or were cancelled' : null,
      });
    }
  }

  return updatedJob;
}

export async function getAttempts(jobId: string): Promise<JobAttemptRecord[]> {
  const existing = await getJob(jobId);
  if (!existing) {
    throw new Error(`Job ${jobId} not found`);
  }

  return getJobAttempts(jobId);
}

export async function renewJobLeaseService(
  jobId: string,
  params: RenewLeaseRequest,
): Promise<RenewLeaseResponse> {
  const durationSeconds = params.duration_seconds ?? 30;
  return renewJobLease(jobId, params.lease_token, durationSeconds);
}

export async function findExpiredLeasesService(
  gracePeriodSeconds: number = 0,
): Promise<JobRecord[]> {
  return findExpiredLeases(gracePeriodSeconds);
}

export async function dispatchDueRetries(): Promise<JobRecord[]> {
  const dueJobs = await findDueRetryingJobs();
  const requeued: JobRecord[] = [];

  for (const job of dueJobs) {
    try {
      const requeuedJob = await requeueJobForRetry(job.id);
      await enqueueJob({
        jobId: requeuedJob.id,
        workflowRunId: requeuedJob.workflow_run_id,
        queuedAt: new Date().toISOString(),
        attempt: requeuedJob.attempt,
      });
      requeued.push(requeuedJob);
    } catch {
      // Best-effort per job
    }
  }

  return requeued;
}

export async function findDueRetryingJobsService(limit: number = 100): Promise<JobRecord[]> {
  return findDueRetryingJobs(limit);
}

export async function findRecoverableJobsService(
  options: FindRecoverableJobsOptions = {},
): Promise<JobRecord[]> {
  return findRecoverableJobs(options);
}

export async function recoverJobService(
  jobId: string,
  reason?: string,
  options: RecoverJobOptions = {},
): Promise<RecoverJobResult> {
  const result = await recoverJob(jobId, reason, options);
  if (result.action === 'requeued') {
    try {
      await enqueueJob({
        jobId: result.job.id,
        workflowRunId: result.job.workflow_run_id,
        queuedAt: new Date().toISOString(),
        attempt: result.job.attempt,
      });
    } catch {
      // Best-effort queueing
    }
  }
  return result;
}

export async function recoverStaleJobsService(
  options: FindRecoverableJobsOptions = {},
): Promise<RecoverJobResult[]> {
  const results = await recoverStaleJobs(options);
  for (const r of results) {
    if (r.action === 'requeued') {
      try {
        await enqueueJob({
          jobId: r.job.id,
          workflowRunId: r.job.workflow_run_id,
          queuedAt: new Date().toISOString(),
          attempt: r.job.attempt,
        });
      } catch {
        // Best-effort queueing
      }
    }
  }
  return results;
}

export { LeaseConflictError };


