import type { JobQueueMessage, JobRecord } from '@mini-ci/types';
import { getRedisClient } from './connection.js';

export const QUEUE_KEY = 'mini_ci:jobs:queued';
export const PROCESSING_KEY = 'mini_ci:jobs:processing';

export async function enqueueJob(msg: JobQueueMessage): Promise<void> {
  const redis = getRedisClient();
  const serialized = JSON.stringify(msg);
  await redis.lpush(QUEUE_KEY, serialized);
}

export async function dequeueJob(timeoutSeconds: number = 0): Promise<JobQueueMessage | null> {
  const redis = getRedisClient();
  let raw: string | null = null;

  if (timeoutSeconds > 0) {
    raw = await redis.brpoplpush(QUEUE_KEY, PROCESSING_KEY, timeoutSeconds);
  } else {
    raw = await redis.rpoplpush(QUEUE_KEY, PROCESSING_KEY);
  }

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as JobQueueMessage;
  } catch {
    return null;
  }
}

export async function acknowledgeJob(jobId: string): Promise<boolean> {
  const redis = getRedisClient();
  const processingItems = await redis.lrange(PROCESSING_KEY, 0, -1);

  for (const item of processingItems) {
    try {
      const parsed = JSON.parse(item) as JobQueueMessage;
      if (parsed.jobId === jobId) {
        await redis.lrem(PROCESSING_KEY, 1, item);
        return true;
      }
    } catch {
      // Ignore unparseable entries
    }
  }

  return false;
}

export async function getQueueLength(): Promise<number> {
  const redis = getRedisClient();
  return redis.llen(QUEUE_KEY);
}

export async function getProcessingLength(): Promise<number> {
  const redis = getRedisClient();
  return redis.llen(PROCESSING_KEY);
}

export async function clearQueue(): Promise<void> {
  const redis = getRedisClient();
  await redis.del(QUEUE_KEY, PROCESSING_KEY);
}

export async function reconcileQueue(queuedJobs: JobRecord[]): Promise<number> {
  const redis = getRedisClient();

  const [queuedItems, processingItems] = await Promise.all([
    redis.lrange(QUEUE_KEY, 0, -1),
    redis.lrange(PROCESSING_KEY, 0, -1),
  ]);

  const activeJobIds = new Set<string>();

  for (const item of [...queuedItems, ...processingItems]) {
    try {
      const parsed = JSON.parse(item) as JobQueueMessage;
      activeJobIds.add(parsed.jobId);
    } catch {
      // Ignore invalid JSON
    }
  }

  let recoveredCount = 0;

  for (const job of queuedJobs) {
    if (!activeJobIds.has(job.id)) {
      await enqueueJob({
        jobId: job.id,
        workflowRunId: job.workflow_run_id,
        queuedAt: new Date().toISOString(),
        attempt: job.attempt,
      });
      recoveredCount++;
    }
  }

  return recoveredCount;
}

export function getWorkerQueueKey(workerId: string): string {
  return `mini_ci:worker:${workerId}:jobs`;
}

export function getWorkerProcessingKey(workerId: string): string {
  return `mini_ci:worker:${workerId}:processing`;
}

export async function enqueueJobForWorker(workerId: string, msg: JobQueueMessage): Promise<void> {
  const redis = getRedisClient();
  const queueKey = getWorkerQueueKey(workerId);
  await redis.lpush(queueKey, JSON.stringify(msg));
}

export async function dequeueJobForWorker(
  workerId: string,
  timeoutSeconds: number = 0,
): Promise<JobQueueMessage | null> {
  const redis = getRedisClient();
  const queueKey = getWorkerQueueKey(workerId);
  const processingKey = getWorkerProcessingKey(workerId);
  let raw: string | null = null;

  if (timeoutSeconds > 0) {
    raw = await redis.brpoplpush(queueKey, processingKey, timeoutSeconds);
  } else {
    raw = await redis.rpoplpush(queueKey, processingKey);
  }

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as JobQueueMessage;
  } catch {
    return null;
  }
}

export async function acknowledgeWorkerJob(workerId: string, jobId: string): Promise<boolean> {
  const redis = getRedisClient();
  const processingKey = getWorkerProcessingKey(workerId);
  const items = await redis.lrange(processingKey, 0, -1);

  for (const item of items) {
    try {
      const parsed = JSON.parse(item) as JobQueueMessage;
      if (parsed.jobId === jobId) {
        await redis.lrem(processingKey, 1, item);
        return true;
      }
    } catch {
      // Ignore unparseable
    }
  }

  return false;
}

export async function getWorkerQueueLength(workerId: string): Promise<number> {
  const redis = getRedisClient();
  return redis.llen(getWorkerQueueKey(workerId));
}

export async function clearWorkerQueue(workerId: string): Promise<void> {
  const redis = getRedisClient();
  await redis.del(getWorkerQueueKey(workerId), getWorkerProcessingKey(workerId));
}
