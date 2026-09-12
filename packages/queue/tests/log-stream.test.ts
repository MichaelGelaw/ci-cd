import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  publishLogChunk,
  publishLogEnd,
  getBufferedLogs,
  clearBufferedLogs,
  subscribeJobLogs,
  closeRedis,
} from '../src/index.js';
import type { LogChunk, LogEndEvent, LogEvent } from '@mini-ci/types';

describe('Log Stream with Redis Pub/Sub and Buffer', () => {
  const testJobId = `job-log-test-${Date.now()}`;

  afterAll(async () => {
    await clearBufferedLogs(testJobId);
    await closeRedis();
  });

  it('publishes and buffers log chunks, and reads buffered logs', async () => {
    const chunk1: LogChunk = {
      jobId: testJobId,
      stream: 'stdout',
      data: 'Building application...\n',
      timestamp: new Date().toISOString(),
      attempt: 1,
    };
    const chunk2: LogChunk = {
      jobId: testJobId,
      stream: 'stderr',
      data: 'Warning: deprecated package\n',
      timestamp: new Date().toISOString(),
      attempt: 1,
    };

    await publishLogChunk(testJobId, chunk1);
    await publishLogChunk(testJobId, chunk2);

    const buffered = await getBufferedLogs(testJobId);
    expect(buffered).toHaveLength(2);
    expect((buffered[0] as LogChunk).data).toBe('Building application...\n');
    expect((buffered[1] as LogChunk).stream).toBe('stderr');
  });

  it('subscribes to live log events and receives published chunks and end event', async () => {
    const liveJobId = `job-live-sub-${Date.now()}`;
    const receivedEvents: LogEvent[] = [];

    // Subscribe to live logs
    const unsubscribe = await subscribeJobLogs(liveJobId, (event) => {
      receivedEvents.push(event);
    });

    // Short delay to ensure Redis subscription is active
    await new Promise((r) => setTimeout(r, 100));

    const chunk: LogChunk = {
      jobId: liveJobId,
      stream: 'stdout',
      data: 'Live log line 1\n',
      timestamp: new Date().toISOString(),
      attempt: 1,
    };
    const endEvent: LogEndEvent = {
      jobId: liveJobId,
      event: 'end',
      exitCode: 0,
      durationMs: 120,
    };

    await publishLogChunk(liveJobId, chunk);
    await publishLogEnd(liveJobId, endEvent);

    // Wait for event delivery
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
    expect((receivedEvents[0] as LogChunk).data).toBe('Live log line 1\n');
    expect((receivedEvents[1] as LogEndEvent).event).toBe('end');
    expect((receivedEvents[1] as LogEndEvent).exitCode).toBe(0);

    await unsubscribe();
    await clearBufferedLogs(liveJobId);
  });
});
