import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  runMigrations,
  closePool,
  getPool,
  getJob,
  listQueuedJobs,
  listWorkers,
} from '@mini-ci/db';
import {
  closeRedis,
  clearQueue,
  getQueueLength,
  publishLogChunk,
  getBufferedLogs,
} from '@mini-ci/queue';
import { buildServer } from '../src/server.js';

describe('Milestone 22: Load Testing (Performance Under High Job Volume)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await runMigrations();
    await clearQueue();
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await clearQueue();
    await app.close();
    await closePool();
    await closeRedis();
  });

  it('1. Handles burst workflow submission concurrently without errors', async () => {
    const numRuns = 30;
    const runPromises = Array.from({ length: numRuns }, (_, i) => {
      const yaml = `
name: load-burst-${i + 1}
steps:
  - name: step-1
    run: echo "step 1 of load burst"
  - name: step-2
    run: echo "step 2 of load burst"
`;
      return app.inject({
        method: 'POST',
        url: '/workflows/runs',
        payload: { yaml },
      });
    });

    const results = await Promise.all(runPromises);

    // All burst submissions must succeed with HTTP 201
    expect(results).toHaveLength(numRuns);
    for (const res of results) {
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.run).toBeDefined();
      expect(body.jobs).toHaveLength(2);
    }

    // Queue must contain all generated jobs
    const queueDepth = await getQueueLength();
    expect(queueDepth).toBeGreaterThanOrEqual(numRuns * 2);
  });

  it('2. Scheduler drains backlog across multiple workers respecting concurrency', async () => {
    // 1. Register 5 workers
    const workerPromises = Array.from({ length: 5 }, (_, i) =>
      app.inject({
        method: 'POST',
        url: '/workers/register',
        payload: {
          id: `load-worker-${i + 1}`,
          name: `Load Worker ${i + 1}`,
          tags: ['docker', 'shell', 'linux'],
        },
      }),
    );
    const workerRes = await Promise.all(workerPromises);
    for (const res of workerRes) {
      expect(res.statusCode).toBe(200);
    }

    // 2. Trigger scheduler tick under high backlog
    const tickRes = await app.inject({
      method: 'POST',
      url: '/scheduler/tick',
    });
    expect(tickRes.statusCode).toBe(200);
    const body = tickRes.json();

    // Scheduler must have assigned jobs to the ready workers
    expect(body.scheduled).toBeDefined();
    expect(body.scheduled.length).toBeGreaterThanOrEqual(1);

    // Assigned workers must now be busy
    for (const decision of body.scheduled) {
      const assigned = await getJob(decision.jobId);
      expect(assigned?.status).toBe('assigned');
      expect(assigned?.worker_id).toBe(decision.workerId);
    }
  });

  it('3. Handles concurrent worker heartbeats without connection pool exhaustion', async () => {
    const numHeartbeats = 30;
    const heartbeatPromises = Array.from({ length: numHeartbeats }, (_, i) =>
      app.inject({
        method: 'POST',
        url: `/workers/load-worker-${(i % 5) + 1}/heartbeat`,
        payload: { status: 'ready' },
      }),
    );

    const results = await Promise.all(heartbeatPromises);
    expect(results).toHaveLength(numHeartbeats);
    for (const res of results) {
      expect(res.statusCode).toBe(200);
      expect(res.json().worker).toBeDefined();
    }
  });

  it('4. Sustains high-throughput log publishing and buffered retrieval', async () => {
    const testJobId = `load-test-log-job-${Date.now()}`;
    const numChunks = 50;

    // Publish 50 log chunks concurrently
    const pubPromises = Array.from({ length: numChunks }, (_, i) =>
      publishLogChunk(testJobId, {
        jobId: testJobId,
        stream: i % 2 === 0 ? 'stdout' : 'stderr',
        data: `Load log output line ${i + 1}`,
        timestamp: new Date().toISOString(),
        attempt: 1,
      }),
    );
    await Promise.all(pubPromises);

    // Retrieve buffered logs
    const buffered = await getBufferedLogs(testJobId);
    expect(buffered.length).toBe(numChunks);
    const firstChunk = buffered[0] as { data?: string };
    expect(firstChunk?.data).toContain('Load log output line');
  });

  it('5. Prometheus metrics accurately record load activity', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const text = res.body;

    // Check key metrics recorded during load testing
    expect(text).toContain('minici_http_requests_total');
    expect(text).toContain('minici_http_request_duration_seconds');
    expect(text).toContain('minici_scheduler_cycle_duration_seconds');
    expect(text).toContain('minici_worker_heartbeats_total');
  });
});
