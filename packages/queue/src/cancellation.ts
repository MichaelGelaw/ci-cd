import { getRedisClient } from './connection.js';
import { Redis } from 'ioredis';

export function getJobCancelChannel(jobId: string): string {
  return `mini_ci:jobs:${jobId}:cancel`;
}

export function getJobCancelledKey(jobId: string): string {
  return `mini_ci:jobs:${jobId}:cancelled`;
}

const DEFAULT_CANCEL_TTL_SECONDS = 3600; // 1 hour

export interface JobCancellationEvent {
  jobId: string;
  reason: string;
  timestamp: string;
}

export async function publishJobCancellation(
  jobId: string,
  reason: string = 'Cancelled by user request',
  ttlSeconds: number = DEFAULT_CANCEL_TTL_SECONDS,
): Promise<void> {
  const redis = getRedisClient();
  const cancelKey = getJobCancelledKey(jobId);
  const cancelChannel = getJobCancelChannel(jobId);

  const payload: JobCancellationEvent = {
    jobId,
    reason,
    timestamp: new Date().toISOString(),
  };
  const payloadStr = JSON.stringify(payload);

  await redis.set(cancelKey, payloadStr, 'EX', ttlSeconds);
  await redis.publish(cancelChannel, payloadStr);
}

export async function isJobCancelled(jobId: string): Promise<boolean> {
  const redis = getRedisClient();
  const cancelKey = getJobCancelledKey(jobId);
  const exists = await redis.exists(cancelKey);
  return exists === 1;
}

export async function clearJobCancellation(jobId: string): Promise<void> {
  const redis = getRedisClient();
  const cancelKey = getJobCancelledKey(jobId);
  await redis.del(cancelKey);
}

export async function subscribeJobCancellation(
  jobId: string,
  onCancel: (event: JobCancellationEvent) => void,
): Promise<() => Promise<void>> {
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const subClient = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const channel = getJobCancelChannel(jobId);

  await subClient.subscribe(channel);

  subClient.on('message', (chan, message) => {
    if (chan === channel) {
      try {
        const parsed = JSON.parse(message) as JobCancellationEvent;
        onCancel(parsed);
      } catch {
        onCancel({
          jobId,
          reason: message,
          timestamp: new Date().toISOString(),
        });
      }
    }
  });

  return async () => {
    try {
      await subClient.unsubscribe(channel);
      await subClient.quit();
    } catch {
      // Ignore cleanup error if already closed
    }
  };
}
