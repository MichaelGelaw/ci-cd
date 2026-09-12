import type { LogChunk, LogEndEvent, LogEvent } from '@mini-ci/types';
import { getRedisClient } from './connection.js';
import { Redis } from 'ioredis';

export function getJobLogChannel(jobId: string): string {
  return `mini_ci:jobs:${jobId}:logs`;
}

export function getJobLogBufferKey(jobId: string): string {
  return `mini_ci:jobs:${jobId}:log_chunks`;
}

const DEFAULT_LOG_TTL_SECONDS = 86400; // 24 hours

export async function publishLogChunk(
  jobId: string,
  chunk: LogChunk,
  ttlSeconds: number = DEFAULT_LOG_TTL_SECONDS,
): Promise<void> {
  const redis = getRedisClient();
  const bufferKey = getJobLogBufferKey(jobId);
  const channel = getJobLogChannel(jobId);
  const payload = JSON.stringify(chunk);

  await redis.rpush(bufferKey, payload);
  await redis.expire(bufferKey, ttlSeconds);
  await redis.publish(channel, payload);
}

export async function publishLogEnd(
  jobId: string,
  endEvent: LogEndEvent,
  ttlSeconds: number = DEFAULT_LOG_TTL_SECONDS,
): Promise<void> {
  const redis = getRedisClient();
  const bufferKey = getJobLogBufferKey(jobId);
  const channel = getJobLogChannel(jobId);
  const payload = JSON.stringify(endEvent);

  await redis.rpush(bufferKey, payload);
  await redis.expire(bufferKey, ttlSeconds);
  await redis.publish(channel, payload);
}

export async function getBufferedLogs(jobId: string): Promise<LogEvent[]> {
  const redis = getRedisClient();
  const bufferKey = getJobLogBufferKey(jobId);
  const rawItems = await redis.lrange(bufferKey, 0, -1);

  return rawItems.map((item) => {
    try {
      return JSON.parse(item) as LogEvent;
    } catch {
      return {
        jobId,
        stream: 'stdout',
        data: item,
        timestamp: new Date().toISOString(),
      } as LogChunk;
    }
  });
}

export async function clearBufferedLogs(jobId: string): Promise<void> {
  const redis = getRedisClient();
  const bufferKey = getJobLogBufferKey(jobId);
  await redis.del(bufferKey);
}

export async function subscribeJobLogs(
  jobId: string,
  onEvent: (event: LogEvent) => void,
): Promise<() => Promise<void>> {
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const subClient = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const channel = getJobLogChannel(jobId);

  await subClient.subscribe(channel);

  subClient.on('message', (chan, message) => {
    if (chan === channel) {
      try {
        const parsed = JSON.parse(message) as LogEvent;
        onEvent(parsed);
      } catch {
        onEvent({
          jobId,
          stream: 'stdout',
          data: message,
          timestamp: new Date().toISOString(),
        } as LogChunk);
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
