import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  runMigrations,
  closePool,
  getPool,
  createJob,
  createWorkflowRun,
  getJob,
  getWorkflowRun,
  updateJobStatus,
  assignJobToWorker,
} from '@mini-ci/db';
import {
  closeRedis,
  clearQueue,
  getQueueLength,
  reconcileQueue,
  dequeueJob,
} from '@mini-ci/queue';
import { buildServer } from '../src/server.js';

describe('Milestone 21: Failure Injection (Intentional Failure Testing)', () => {
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

  it('1. Recovers job and schedules retry when worker crashes and lease expires', async () => {
    // 1. Register a worker
    const workerRes = await app.inject({
      method: 'POST',
      url: '/workers/register',
      payload: {
        id: 'chaos-worker-1',
        name: 'Chaos Worker 1',
        tags: ['docker', 'shell', 'linux'],
      },
    });
    expect(workerRes.statusCode).toBe(200);

    // 2. Submit workflow run
    const yaml = `
name: chaos-worker-crash
steps:
  - name: crash-step
    run: echo 'about to crash'
`;
    const runRes = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      payload: { yaml },
    });
    expect(runRes.statusCode).toBe(201);
    const initialJob = runRes.json().jobs[0];

    // 3. Assign job to chaos-worker-1
    await assignJobToWorker(initialJob.id, 'chaos-worker-1');

    const assignedJob = await getJob(initialJob.id);
    expect(assignedJob).not.toBeNull();
    expect(assignedJob?.status).toBe('assigned');
    expect(assignedJob?.worker_id).toBe('chaos-worker-1');

    // 4. Worker claims and begins running
    const runningRes = await app.inject({
      method: 'POST',
      url: `/jobs/${initialJob.id}/status`,
      payload: {
        status: 'running',
        worker_id: 'chaos-worker-1',
      },
    });
    expect(runningRes.statusCode).toBe(200);

    // 5. Simulate worker crash:
    // Mark worker last_heartbeat_at as 60 seconds ago, expire the lease in PostgreSQL
    const pool = getPool();
    await pool.query(
      `UPDATE workers SET last_heartbeat_at = NOW() - interval '60 seconds' WHERE id = $1`,
      ['chaos-worker-1'],
    );
    await pool.query(
      `UPDATE jobs SET lease_expires_at = NOW() - interval '10 seconds' WHERE id = $1`,
      [initialJob.id],
    );

    // 6. Scheduler tick should detect dead worker / expired lease and recover job
    const tick2 = await app.inject({
      method: 'POST',
      url: '/scheduler/tick',
    });
    expect(tick2.statusCode).toBe(200);
    const tick2Body = tick2.json();
    expect(tick2Body.recovered.length).toBeGreaterThanOrEqual(1);

    // 7. Verify job has transitioned to retrying with lease cleared
    const recoveredJob = await getJob(initialJob.id);
    expect(recoveredJob).not.toBeNull();
    expect(recoveredJob?.lease_token).toBeNull();
    expect(recoveredJob?.lease_expires_at).toBeNull();
    expect(['retrying', 'queued', 'failed']).toContain(recoveredJob?.status);
    expect(recoveredJob?.error).toContain('Worker failure');
  });

  it('2. Enforces fencing and rejects split-brain stale worker updates with HTTP 409', async () => {
    // 1. Create a job directly in assigned/running state with a specific lease token
    const run = await createWorkflowRun('chaos-fencing-test');
    const job = await createJob({
      workflowRunId: run.id,
      name: 'fencing-job',
      command: 'sleep 30',
      status: 'assigned',
    });

    const pool = getPool();
    await pool.query(
      `UPDATE jobs SET worker_id = 'stale-worker-a', lease_token = 'valid-token-worker-b', lease_duration_seconds = 30, lease_expires_at = NOW() + interval '30 seconds' WHERE id = $1`,
      [job.id],
    );

    // 2. Simulate Stale Worker A trying to renew with an old/invalid token
    const staleRenewRes = await app.inject({
      method: 'POST',
      url: `/jobs/${job.id}/lease/renew`,
      payload: {
        lease_token: 'stale-token-worker-a',
        duration_seconds: 30,
      },
    });

    // Control plane must reject with HTTP 409 LEASE_CONFLICT
    expect(staleRenewRes.statusCode).toBe(409);
    expect(staleRenewRes.json().error.code).toBe('LEASE_CONFLICT');

    // 3. Legitimate Worker B renews with correct lease token
    const validRenewRes = await app.inject({
      method: 'POST',
      url: `/jobs/${job.id}/lease/renew`,
      payload: {
        lease_token: 'valid-token-worker-b',
        duration_seconds: 30,
      },
    });
    expect(validRenewRes.statusCode).toBe(200);
    expect(validRenewRes.json().job.id).toBe(job.id);
  });

  it('3. Reconciles Redis queue loss against PostgreSQL durable state', async () => {
    // 1. Create 3 queued jobs in PostgreSQL
    const run = await createWorkflowRun('chaos-queue-reconcile-test');
    const job1 = await createJob({
      workflowRunId: run.id,
      name: 'job-rec-1',
      command: 'echo 1',
      status: 'queued',
    });
    const job2 = await createJob({
      workflowRunId: run.id,
      name: 'job-rec-2',
      command: 'echo 2',
      status: 'queued',
    });
    const job3 = await createJob({
      workflowRunId: run.id,
      name: 'job-rec-3',
      command: 'echo 3',
      status: 'queued',
    });

    // 2. Simulate Redis queue outage / data flush
    await clearQueue();
    const lenBefore = await getQueueLength();
    expect(lenBefore).toBe(0);

    // 3. Reconcile queue from PostgreSQL queued jobs
    const restoredCount = await reconcileQueue([job1, job2, job3]);
    expect(restoredCount).toBe(3);

    const lenAfter = await getQueueLength();
    expect(lenAfter).toBe(3);

    // 4. Verify jobs can be dequeued cleanly
    const msg = await dequeueJob(1);
    expect(msg).not.toBeNull();
    expect([job1.id, job2.id, job3.id]).toContain(msg?.jobId);
  });

  it('4. Transitions job and workflow run to failed when retries are exhausted', async () => {
    const run = await createWorkflowRun('chaos-exhaust-retries-test');
    // Job with max_attempts = 1 (no retries allowed)
    const job = await createJob({
      workflowRunId: run.id,
      name: 'exhaust-job',
      command: 'echo fail',
      status: 'running',
      maxAttempts: 1,
    });

    // Set worker_id, attempt, and expire lease
    const pool = getPool();
    await pool.query(
      `UPDATE jobs SET worker_id = 'doomed-worker', attempt = 1, max_attempts = 1, lease_expires_at = NOW() - interval '5 seconds' WHERE id = $1`,
      [job.id],
    );

    // Trigger scheduler recovery
    const tick = await app.inject({
      method: 'POST',
      url: '/scheduler/tick',
    });
    expect(tick.statusCode).toBe(200);

    // Job must transition to failed because max_attempts was reached
    const failedJob = await getJob(job.id);
    expect(failedJob?.status).toBe('failed');
    expect(failedJob?.error).toContain('Worker failure');

    // Workflow run should reflect failure
    const finalRun = await getWorkflowRun(run.id);
    expect(finalRun?.status).toBe('failed');
  });

  it('5. Propagates failure to downstream dependent jobs in a DAG', async () => {
    const yaml = `
name: chaos-dag-failure
jobs:
  root-job:
    run: exit 1
  dependent-job:
    needs: [root-job]
    run: echo 'should not execute'
`;
    const runRes = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      payload: { yaml },
    });
    expect(runRes.statusCode).toBe(201);
    const jobs = runRes.json().jobs;

    const rootJob = jobs.find((j: { name: string }) => j.name === 'root-job');
    const depJob = jobs.find((j: { name: string }) => j.name === 'dependent-job');

    expect(rootJob.status).toBe('queued');
    expect(depJob.status).toBe('created');

    // Simulate root-job executing and failing: queued -> assigned -> running -> failed
    await assignJobToWorker(rootJob.id, 'chaos-worker-1');
    await updateJobStatus(rootJob.id, 'running');
    await updateJobStatus(rootJob.id, 'failed', {
      exitCode: 1,
      error: 'Simulated failure injection',
    });

    // Run scheduler tick to evaluate dependencies
    const tick = await app.inject({
      method: 'POST',
      url: '/scheduler/tick',
    });
    expect(tick.statusCode).toBe(200);

    // Dependent job must not be promoted to queued
    const depJobAfter = await getJob(depJob.id);
    expect(depJobAfter?.status).not.toBe('queued');
    expect(depJobAfter?.status).not.toBe('running');
  });
});
