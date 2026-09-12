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
  LeaseConflictError,
} from '@mini-ci/db';


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
  } else if (params.status === 'succeeded' || params.status === 'failed' || params.status === 'cancelled') {
    updates.finishedAt = new Date();
  }

  const updatedJob = await updateJobStatus(jobId, params.status, updates);

  // If entering terminal or running status, record attempt
  if (params.status === 'running' || params.status === 'succeeded' || params.status === 'failed') {
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
      });
    } catch {
      // Best-effort attempt recording
    }
  }

  // Check if all jobs for the workflow run have completed
  if (['succeeded', 'failed', 'cancelled'].includes(params.status)) {
    const siblingJobs = await getJobsByWorkflowRun(updatedJob.workflow_run_id);
    const allTerminal = siblingJobs.every((j) =>
      ['succeeded', 'failed', 'cancelled'].includes(j.status),
    );

    if (allTerminal) {
      const anyFailed = siblingJobs.some((j) => j.status === 'failed' || j.status === 'cancelled');
      const totalDuration = siblingJobs.reduce((acc, j) => acc + (j.duration_ms ?? 0), 0);
      await updateWorkflowRun(updatedJob.workflow_run_id, {
        status: anyFailed ? 'failed' : 'succeeded',
        finished_at: new Date(),
        duration_ms: totalDuration,
        error: anyFailed ? 'One or more jobs failed or were cancelled' : null,
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

export { LeaseConflictError };

