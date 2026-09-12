import type { JobRecord, JobAttemptRecord } from '@mini-ci/types';
import {
  getJob,
  updateJobStatus,
  getJobAttempts,
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

export async function getAttempts(jobId: string): Promise<JobAttemptRecord[]> {
  const existing = await getJob(jobId);
  if (!existing) {
    throw new Error(`Job ${jobId} not found`);
  }

  return getJobAttempts(jobId);
}
