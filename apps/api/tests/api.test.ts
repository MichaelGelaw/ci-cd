import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runMigrations, closePool, getPool, assignJobToWorker } from '@mini-ci/db';
import {
  closeRedis,
  clearQueue,
  getQueueLength,
  publishLogChunk,
  publishLogEnd,
  clearBufferedLogs,
} from '@mini-ci/queue';
import { buildServer } from '../src/server.js';

describe('REST API Control Plane', () => {
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

  it('GET /health returns 200 with database and redis connected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(body.redis).toBe('connected');
    expect(body.timestamp).toBeTruthy();
  });

  it('POST /workflows/runs creates a run and queued jobs from raw YAML', async () => {
    const yaml = `
name: api-submission-test
image: alpine:latest

steps:
  - name: step-1
    run: echo "hello from api"
  - name: step-2
    run: echo "second step"
`;

    const res = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      headers: {
        'content-type': 'application/x-yaml',
      },
      payload: yaml,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();

    expect(body.run).toBeTruthy();
    expect(body.run.workflow_name).toBe('api-submission-test');
    expect(body.run.status).toBe('running');

    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0].name).toBe('step-1');
    expect(body.jobs[0].status).toBe('queued');
    expect(body.jobs[1].name).toBe('step-2');
    expect(body.jobs[1].status).toBe('queued');

    const queueLength = await getQueueLength();
    expect(queueLength).toBeGreaterThanOrEqual(2);
  });

  it('POST /workflows/runs creates a run from JSON body containing yaml', async () => {
    const payload = {
      yaml: `
name: json-api-test
steps:
  - run: echo "json test"
`,
    };

    const res = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      headers: {
        'content-type': 'application/json',
      },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.run.workflow_name).toBe('json-api-test');
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].status).toBe('queued');
  });

  it('POST /workflows/runs rejects invalid workflow definitions with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      headers: {
        'content-type': 'application/x-yaml',
      },
      payload: `
name: missing-steps
`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBeTruthy();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /workflows/runs rejects missing request body with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      headers: {
        'content-type': 'application/json',
      },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('INVALID_REQUEST_BODY');
  });

  it('GET /workflow-runs lists runs with pagination', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workflow-runs?limit=5&offset=0',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.runs.length).toBeGreaterThanOrEqual(1);
    expect(body.limit).toBe(5);
    expect(body.offset).toBe(0);
  });

  it('GET /workflow-runs/:id returns run details and child jobs', async () => {
    // First create a run
    const createRes = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      headers: { 'content-type': 'application/x-yaml' },
      payload: `
name: details-test
steps:
  - run: echo "details"
`,
    });

    const runId = createRes.json().run.id;

    const res = await app.inject({
      method: 'GET',
      url: `/workflow-runs/${runId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run.id).toBe(runId);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].name).toBe('Step 1');
  });

  it('GET /workflow-runs/:id returns 404 for unknown run', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workflow-runs/00000000-0000-0000-0000-000000000000',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /jobs/:id returns specific job record', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      headers: { 'content-type': 'application/x-yaml' },
      payload: `
name: single-job-test
steps:
  - name: my-job
    run: echo "test"
`,
    });

    const jobId = createRes.json().jobs[0].id;

    const res = await app.inject({
      method: 'GET',
      url: `/jobs/${jobId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.job.id).toBe(jobId);
    expect(body.job.name).toBe('my-job');
    expect(body.job.status).toBe('queued');
  });

  it('POST /jobs/:id/status updates job progress and state', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      headers: { 'content-type': 'application/x-yaml' },
      payload: `
name: status-update-test
steps:
  - name: test-status
    run: echo "test"
`,
    });

    const jobId = createRes.json().jobs[0].id;

    // Transition: queued -> assigned
    const assignRes = await app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/status`,
      payload: { status: 'assigned', worker_id: 'worker-test-1' },
    });
    expect(assignRes.statusCode).toBe(200);
    expect(assignRes.json().job.status).toBe('assigned');
    expect(assignRes.json().job.worker_id).toBe('worker-test-1');

    // Transition: assigned -> running
    const runRes = await app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/status`,
      payload: { status: 'running' },
    });
    expect(runRes.statusCode).toBe(200);
    expect(runRes.json().job.status).toBe('running');

    // Transition: running -> succeeded
    const finishRes = await app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/status`,
      payload: {
        status: 'succeeded',
        exit_code: 0,
        stdout: 'job output',
        duration_ms: 150,
      },
    });
    expect(finishRes.statusCode).toBe(200);
    expect(finishRes.json().job.status).toBe('succeeded');
    expect(finishRes.json().job.exit_code).toBe(0);
    expect(finishRes.json().job.stdout).toBe('job output');
  });

  it('POST /jobs/:id/status rejects invalid transitions with 400', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      headers: { 'content-type': 'application/x-yaml' },
      payload: `
name: invalid-transition-test
steps:
  - run: echo "hi"
`,
    });

    const jobId = createRes.json().jobs[0].id;

    // Direct queued -> succeeded is illegal (must be assigned -> running -> succeeded)
    const badRes = await app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/status`,
      payload: { status: 'succeeded' },
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json().error.code).toBe('INVALID_TRANSITION');
  });

  it('POST /jobs/:id/cancel cancels a queued job', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      headers: { 'content-type': 'application/x-yaml' },
      payload: `
name: cancel-test
steps:
  - run: echo "will be cancelled"
`,
    });

    const jobId = createRes.json().jobs[0].id;

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/jobs/${jobId}/cancel`,
    });

    expect(cancelRes.statusCode).toBe(200);
    const cancelBody = cancelRes.json();
    expect(cancelBody.job.status).toBe('cancelled');
    expect(cancelBody.job.error).toContain('Cancelled by user request via API');

    // Verify it in subsequent GET
    const getRes = await app.inject({
      method: 'GET',
      url: `/jobs/${jobId}`,
    });
    expect(getRes.json().job.status).toBe('cancelled');
  });

  it('POST /jobs/:id/cancel returns 404 for non-existent job', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/jobs/00000000-0000-0000-0000-000000000000/cancel',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('GET /jobs/:id/attempts returns attempts array', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      headers: { 'content-type': 'application/x-yaml' },
      payload: `
name: attempts-api-test
steps:
  - run: echo "attempt"
`,
    });

    const jobId = createRes.json().jobs[0].id;

    const res = await app.inject({
      method: 'GET',
      url: `/jobs/${jobId}/attempts`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.attempts)).toBe(true);
  });

  it('returns standardized 404 on undefined routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/non-existent-endpoint',
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('/non-existent-endpoint');
  });

  describe('Worker Registration and Discovery API', () => {
    const testWorkerId = `test-api-worker-${Date.now()}`;

    it('POST /workers/register validates required name field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/workers/register',
        payload: { id: 'missing-name' },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('INVALID_REQUEST_BODY');
      expect(body.error.message).toContain('"name"');
    });

    it('POST /workers/register registers worker successfully', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/workers/register',
        payload: {
          id: testWorkerId,
          name: 'ci-runner-linux-01',
          address: '192.168.1.50:8000',
          tags: ['docker', 'linux', 'x86_64'],
          metadata: { cpus: 8, memory_gb: 16 },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.worker).toBeDefined();
      expect(body.worker.id).toBe(testWorkerId);
      expect(body.worker.name).toBe('ci-runner-linux-01');
      expect(body.worker.status).toBe('ready');
      expect(body.worker.address).toBe('192.168.1.50:8000');
      expect(body.worker.tags).toEqual(['docker', 'linux', 'x86_64']);
      expect(body.worker.metadata).toEqual({ cpus: 8, memory_gb: 16 });
      expect(body.worker.registered_at).toBeTruthy();
      expect(body.worker.last_heartbeat_at).toBeTruthy();
    });

    it('POST /workers/register idempotently updates existing worker', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/workers/register',
        payload: {
          id: testWorkerId,
          name: 'ci-runner-linux-01-updated',
          address: '192.168.1.51:8000',
          tags: ['docker', 'linux', 'arm64'],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.worker.id).toBe(testWorkerId);
      expect(body.worker.name).toBe('ci-runner-linux-01-updated');
      expect(body.worker.address).toBe('192.168.1.51:8000');
      expect(body.worker.tags).toEqual(['docker', 'linux', 'arm64']);
    });

    it('GET /workers returns registered workers with optional status filter', async () => {
      const allRes = await app.inject({
        method: 'GET',
        url: '/workers',
      });
      expect(allRes.statusCode).toBe(200);
      const allBody = allRes.json();
      expect(Array.isArray(allBody.workers)).toBe(true);
      expect(allBody.workers.some((w: any) => w.id === testWorkerId)).toBe(true);

      const readyRes = await app.inject({
        method: 'GET',
        url: '/workers?status=ready',
      });
      expect(readyRes.statusCode).toBe(200);
      const readyBody = readyRes.json();
      expect(readyBody.workers.some((w: any) => w.id === testWorkerId)).toBe(true);

      const invalidRes = await app.inject({
        method: 'GET',
        url: '/workers?status=invalid_status',
      });
      expect(invalidRes.statusCode).toBe(400);
      expect(invalidRes.json().error.code).toBe('INVALID_QUERY_PARAMETER');
    });

    it('GET /workers/:id returns specific worker details or 404', async () => {
      const foundRes = await app.inject({
        method: 'GET',
        url: `/workers/${testWorkerId}`,
      });
      expect(foundRes.statusCode).toBe(200);
      expect(foundRes.json().worker.id).toBe(testWorkerId);

      const notFoundRes = await app.inject({
        method: 'GET',
        url: '/workers/non-existent-worker-id',
      });
      expect(notFoundRes.statusCode).toBe(404);
      expect(notFoundRes.json().error.code).toBe('NOT_FOUND');
    });

    it('POST /workers/:id/heartbeat updates worker timestamp and status', async () => {
      const heartbeatRes = await app.inject({
        method: 'POST',
        url: `/workers/${testWorkerId}/heartbeat`,
        payload: { status: 'busy' },
      });

      expect(heartbeatRes.statusCode).toBe(200);
      const body = heartbeatRes.json();
      expect(body.worker.id).toBe(testWorkerId);
      expect(body.worker.status).toBe('busy');

      const notFoundHeartbeat = await app.inject({
        method: 'POST',
        url: '/workers/missing-worker/heartbeat',
      });
      expect(notFoundHeartbeat.statusCode).toBe(404);
    });

    it('GET /workers/stale and POST /workers/reap identify and transition dead workers', async () => {
      const deadWorkerId = `dead-worker-${Date.now()}`;
      await app.inject({
        method: 'POST',
        url: '/workers/register',
        payload: { id: deadWorkerId, name: 'stale-node', tags: ['shell'] },
      });

      // Backdate heartbeat
      const pool = getPool();
      await pool.query(
        "UPDATE workers SET last_heartbeat_at = NOW() - INTERVAL '120 seconds' WHERE id = $1;",
        [deadWorkerId],
      );

      // GET /workers/stale
      const staleRes = await app.inject({
        method: 'GET',
        url: '/workers/stale?timeout_seconds=30',
      });
      expect(staleRes.statusCode).toBe(200);
      const staleBody = staleRes.json();
      expect(staleBody.staleWorkers.some((w: any) => w.id === deadWorkerId)).toBe(true);

      // POST /workers/reap
      const reapRes = await app.inject({
        method: 'POST',
        url: '/workers/reap',
        payload: { timeout_seconds: 30 },
      });
      expect(reapRes.statusCode).toBe(200);
      const reapBody = reapRes.json();
      expect(reapBody.reapedWorkers.some((w: any) => w.id === deadWorkerId)).toBe(true);

      // Verify worker is now offline
      const checkRes = await app.inject({
        method: 'GET',
        url: `/workers/${deadWorkerId}`,
      });
      expect(checkRes.json().worker.status).toBe('offline');
    });
  });

  describe('Scheduler API', () => {
    it('POST /scheduler/tick triggers a scheduling cycle', async () => {
      const tickRes = await app.inject({
        method: 'POST',
        url: '/scheduler/tick',
      });

      expect(tickRes.statusCode).toBe(200);
      const body = tickRes.json();
      expect(Array.isArray(body.scheduled)).toBe(true);
    });
  });

  describe('Leases API', () => {
    it('renews valid job lease and enforces fencing on mismatch or expiration', async () => {
      // Create a workflow run with a job
      const runRes = await app.inject({
        method: 'POST',
        url: '/workflows/runs',
        headers: { 'content-type': 'application/json' },
        payload: {
          yaml: `
name: lease-api-test
steps:
  - run: echo "lease testing"
`,
        },
      });
      const runBody = runRes.json();
      const jobId = runBody.jobs[0].id;

      // Assign job to worker to grant initial lease
      const assigned = await assignJobToWorker(jobId, 'worker-lease-1', 30);
      expect(assigned.lease_token).toBeTruthy();

      // POST /jobs/:id/lease/renew without lease_token -> 400
      const missingTokenRes = await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/lease/renew`,
        payload: {},
      });
      expect(missingTokenRes.statusCode).toBe(400);

      // POST /jobs/:id/lease/renew with wrong lease_token -> 409 LEASE_CONFLICT
      const mismatchRes = await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/lease/renew`,
        payload: { lease_token: 'bogus-token' },
      });
      expect(mismatchRes.statusCode).toBe(409);
      expect(mismatchRes.json().error.code).toBe('LEASE_CONFLICT');

      // POST /jobs/:id/lease/renew with correct lease_token -> 200
      const renewRes = await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/lease/renew`,
        payload: {
          lease_token: assigned.lease_token,
          duration_seconds: 60,
        },
      });
      expect(renewRes.statusCode).toBe(200);
      const renewBody = renewRes.json();
      expect(renewBody.job.lease_duration_seconds).toBe(60);
      expect(new Date(renewBody.lease_expires_at).getTime()).toBeGreaterThan(
        new Date(assigned.lease_expires_at!).getTime(),
      );

      // Backdate lease in DB to test expired lease rejection
      const pool = getPool();
      await pool.query(
        "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '30 seconds' WHERE id = $1;",
        [jobId],
      );

      // GET /jobs/leases/expired should now list this job
      const expiredRes = await app.inject({
        method: 'GET',
        url: '/jobs/leases/expired',
      });
      expect(expiredRes.statusCode).toBe(200);
      const expiredBody = expiredRes.json();
      expect(expiredBody.jobs.some((j: any) => j.id === jobId)).toBe(true);

      // Renewing expired lease should return 409 LEASE_CONFLICT
      const renewExpiredRes = await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/lease/renew`,
        payload: {
          lease_token: assigned.lease_token,
          duration_seconds: 30,
        },
      });
      expect(renewExpiredRes.statusCode).toBe(409);
      expect(renewExpiredRes.json().error.code).toBe('LEASE_CONFLICT');
    });
  });

  describe('Retries API', () => {
    it('manages retry lifecycle: retrying transition, backoff dispatch, and final resolution', async () => {
      // 1. Submit workflow with a step configured with retries: 1 (max_attempts = 2)
      const submitRes = await app.inject({
        method: 'POST',
        url: '/workflows/runs',
        headers: { 'content-type': 'application/json' },
        payload: {
          yaml: `
name: retry-api-test
steps:
  - name: test-flaky
    run: exit 1
    retry:
      max_attempts: 2
      base_delay_seconds: 10
      jitter: false
`,
        },
      });

      expect(submitRes.statusCode).toBe(201);
      const submitBody = submitRes.json();
      const runId = submitBody.run.id;
      const jobId = submitBody.jobs[0].id;

      expect(submitBody.jobs[0].max_attempts).toBe(2);
      expect(submitBody.jobs[0].attempt).toBe(1);

      // Transition job: queued -> assigned -> running
      await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: { status: 'assigned', worker_id: 'worker-r1' },
      });
      await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: { status: 'running', worker_id: 'worker-r1' },
      });

      // 2. Report failure on attempt 1. Since attempt 1 < max_attempts (2), job transitions to 'retrying'
      const failRes = await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: {
          status: 'failed',
          exit_code: 1,
          stderr: 'Temporary network failure',
        },
      });

      expect(failRes.statusCode).toBe(200);
      const failBody = failRes.json();
      expect(failBody.job.status).toBe('retrying');
      expect(failBody.job.next_retry_at).toBeTruthy();

      // Workflow run should STILL be 'running' (not failed!)
      const runCheck1 = await app.inject({
        method: 'GET',
        url: `/workflow-runs/${runId}`,
      });
      expect(runCheck1.json().run.status).toBe('running');

      // Attempt history should record attempt 1 as failed
      const attemptsRes = await app.inject({
        method: 'GET',
        url: `/jobs/${jobId}/attempts`,
      });
      expect(attemptsRes.json().attempts).toHaveLength(1);
      expect(attemptsRes.json().attempts[0].status).toBe('failed');
      expect(attemptsRes.json().attempts[0].attempt_number).toBe(1);

      // Fast-forward next_retry_at into the past so it becomes due
      const pool = getPool();
      await pool.query(
        "UPDATE jobs SET next_retry_at = NOW() - INTERVAL '10 seconds' WHERE id = $1;",
        [jobId],
      );

      // GET /jobs/retries/due should list this job
      const dueRes = await app.inject({
        method: 'GET',
        url: '/jobs/retries/due',
      });
      expect(dueRes.statusCode).toBe(200);
      const dueBody = dueRes.json();
      expect(dueBody.dueJobs.some((j: any) => j.id === jobId)).toBe(true);

      // 3. POST /jobs/retries/dispatch should re-enqueue to 'queued' with attempt = 2
      const dispatchRes = await app.inject({
        method: 'POST',
        url: '/jobs/retries/dispatch',
      });
      expect(dispatchRes.statusCode).toBe(200);
      const dispatchBody = dispatchRes.json();
      expect(dispatchBody.retried.some((j: any) => j.id === jobId)).toBe(true);

      // Verify job is now queued with attempt 2
      const jobCheck = await app.inject({
        method: 'GET',
        url: `/jobs/${jobId}`,
      });
      expect(jobCheck.json().job.status).toBe('queued');
      expect(jobCheck.json().job.attempt).toBe(2);

      // 4. Second attempt execution: queued -> assigned -> running -> succeeded
      await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: { status: 'assigned', worker_id: 'worker-r2' },
      });
      await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: { status: 'running', worker_id: 'worker-r2' },
      });
      const succeedRes = await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: {
          status: 'succeeded',
          exit_code: 0,
          stdout: 'Success on retry!',
        },
      });
      expect(succeedRes.statusCode).toBe(200);
      expect(succeedRes.json().job.status).toBe('succeeded');

      // Workflow run should now be 'succeeded'!
      const runCheck2 = await app.inject({
        method: 'GET',
        url: `/workflow-runs/${runId}`,
      });
      expect(runCheck2.json().run.status).toBe('succeeded');

      // Attempt history should contain both attempt 1 and attempt 2
      const finalAttempts = await app.inject({
        method: 'GET',
        url: `/jobs/${jobId}/attempts`,
      });
      expect(finalAttempts.json().attempts).toHaveLength(2);
    });
  });

  describe('Recovery API', () => {
    it('discovers recoverable jobs and recovers individual orphaned jobs', async () => {
      // 1. Submit workflow with a 2-attempt job
      const submitRes = await app.inject({
        method: 'POST',
        url: '/workflows/runs',
        headers: { 'content-type': 'application/json' },
        payload: {
          yaml: `
name: recovery-test
steps:
  - name: step-rec
    run: echo "test recovery"
    retry:
      max_attempts: 2
`,
        },
      });

      expect(submitRes.statusCode).toBe(201);
      const submitBody = submitRes.json();
      const jobId = submitBody.jobs[0].id;

      // Register worker
      const workerRes = await app.inject({
        method: 'POST',
        url: '/workers/register',
        payload: { name: 'worker-rec-node', id: `worker-rec-${Date.now()}` },
      });
      const workerId = workerRes.json().worker.id;

      // Transition job: queued -> assigned -> running
      await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: { status: 'assigned', worker_id: workerId },
      });
      await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: { status: 'running', worker_id: workerId },
      });

      // Backdate lease in DB to simulate worker crash / expired lease
      const pool = getPool();
      await pool.query(
        "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '30 seconds' WHERE id = $1;",
        [jobId],
      );

      // GET /jobs/recoverable should find this job
      const listRes = await app.inject({
        method: 'GET',
        url: '/jobs/recoverable',
      });
      expect(listRes.statusCode).toBe(200);
      const listBody = listRes.json();
      expect(listBody.recoverableJobs.some((j: any) => j.id === jobId)).toBe(true);

      // POST /jobs/:id/recover should recover the job
      const recRes = await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/recover`,
        payload: { reason: 'Worker crashed unexpectedly' },
      });
      expect(recRes.statusCode).toBe(200);
      const recBody = recRes.json();
      expect(recBody.action).toBe('retrying');
      expect(recBody.job.status).toBe('retrying');
      expect(recBody.job.lease_token).toBeNull();

      // Verify attempt 1 was marked as failed
      const attemptsRes = await app.inject({
        method: 'GET',
        url: `/jobs/${jobId}/attempts`,
      });
      expect(attemptsRes.json().attempts).toHaveLength(1);
      expect(attemptsRes.json().attempts[0].status).toBe('failed');
      expect(attemptsRes.json().attempts[0].error).toContain('Worker crashed');
    });

    it('cascades job recovery when dead workers are reaped via POST /workers/reap', async () => {
      // 1. Submit workflow
      const submitRes = await app.inject({
        method: 'POST',
        url: '/workflows/runs',
        headers: { 'content-type': 'application/json' },
        payload: {
          yaml: `
name: reap-recovery-test
steps:
  - name: step-reaped
    run: echo "test reap recovery"
    retry:
      max_attempts: 2
`,
        },
      });

      const jobId = submitRes.json().jobs[0].id;

      // 2. Register worker
      const workerRes = await app.inject({
        method: 'POST',
        url: '/workers/register',
        payload: { name: 'worker-doomed', id: `worker-doomed-${Date.now()}` },
      });
      const workerId = workerRes.json().worker.id;

      // 3. Assign and set running
      await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: { status: 'assigned', worker_id: workerId },
      });
      await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: { status: 'running', worker_id: workerId },
      });

      // 4. Backdate worker heartbeat to 60s ago
      const pool = getPool();
      await pool.query(
        "UPDATE workers SET last_heartbeat_at = NOW() - INTERVAL '60 seconds' WHERE id = $1;",
        [workerId],
      );

      // 5. POST /workers/reap should reap worker and recover the abandoned job
      const reapRes = await app.inject({
        method: 'POST',
        url: '/workers/reap',
        payload: { timeout_seconds: 30 },
      });
      expect(reapRes.statusCode).toBe(200);
      const reapBody = reapRes.json();
      expect(reapBody.reapedWorkers.some((w: any) => w.id === workerId)).toBe(true);
      expect(reapBody.recoveredJobs.some((r: any) => r.job.id === jobId)).toBe(true);

      // Verify job is no longer running
      const jobCheck = await app.inject({
        method: 'GET',
        url: `/jobs/${jobId}`,
      });
      expect(jobCheck.json().job.status).toBe('retrying');
    });

    it('POST /scheduler/tick recovers stale jobs before retrying and scheduling', async () => {
      const tickRes = await app.inject({
        method: 'POST',
        url: '/scheduler/tick',
      });
      expect(tickRes.statusCode).toBe(200);
      const tickBody = tickRes.json();
      expect(tickBody).toHaveProperty('recovered');
      expect(tickBody).toHaveProperty('retried');
      expect(tickBody).toHaveProperty('scheduled');
    });
  });

  describe('Logs API', () => {
    it('returns 404 for non-existent job logs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/jobs/00000000-0000-0000-0000-000000000000/logs',
      });
      expect(res.statusCode).toBe(404);
    });

    it('retrieves static logs in JSON and text formats with stream filtering', async () => {
      const submitRes = await app.inject({
        method: 'POST',
        url: '/workflows/runs',
        headers: { 'content-type': 'application/json' },
        payload: {
          yaml: `
name: logs-api-test
steps:
  - run: echo "logs test"
`,
        },
      });
      const jobId = submitRes.json().jobs[0].id;

      // Seed buffered log chunks into Redis
      await publishLogChunk(jobId, {
        jobId,
        stream: 'stdout',
        data: 'Step 1 output\n',
        timestamp: new Date().toISOString(),
        attempt: 1,
      });
      await publishLogChunk(jobId, {
        jobId,
        stream: 'stderr',
        data: 'Warning: test warning\n',
        timestamp: new Date().toISOString(),
        attempt: 1,
      });

      // GET /jobs/:id/logs JSON format
      const jsonRes = await app.inject({
        method: 'GET',
        url: `/jobs/${jobId}/logs`,
      });
      expect(jsonRes.statusCode).toBe(200);
      const jsonBody = jsonRes.json();
      expect(jsonBody.jobId).toBe(jobId);
      expect(jsonBody.stdout).toContain('Step 1 output');
      expect(jsonBody.stderr).toContain('Warning: test warning');
      expect(jsonBody.events).toHaveLength(2);

      // GET /jobs/:id/logs text format
      const textRes = await app.inject({
        method: 'GET',
        url: `/jobs/${jobId}/logs?format=text`,
      });
      expect(textRes.statusCode).toBe(200);
      expect(textRes.body).toContain('Step 1 output');
      expect(textRes.body).toContain('Warning: test warning');

      // Filter by stream: stdout only
      const stdoutRes = await app.inject({
        method: 'GET',
        url: `/jobs/${jobId}/logs?stream=stdout&format=text`,
      });
      expect(stdoutRes.statusCode).toBe(200);
      expect(stdoutRes.body).toContain('Step 1 output');
      expect(stdoutRes.body).not.toContain('Warning: test warning');

      await clearBufferedLogs(jobId);
    });

    it('streams logs via Server-Sent Events (SSE) with live chunks and end event', async () => {
      const submitRes = await app.inject({
        method: 'POST',
        url: '/workflows/runs',
        headers: { 'content-type': 'application/json' },
        payload: {
          yaml: `
name: sse-test
steps:
  - run: echo "sse live"
`,
        },
      });
      const jobId = submitRes.json().jobs[0].id;

      // Set job running
      await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: { status: 'assigned', worker_id: 'worker-sse' },
      });
      await app.inject({
        method: 'POST',
        url: `/jobs/${jobId}/status`,
        payload: { status: 'running', worker_id: 'worker-sse' },
      });

      // Seed one buffered chunk
      await publishLogChunk(jobId, {
        jobId,
        stream: 'stdout',
        data: 'Initial buffered line\n',
        timestamp: new Date().toISOString(),
        attempt: 1,
      });

      // Launch async SSE stream injection
      const streamPromise = app.inject({
        method: 'GET',
        url: `/jobs/${jobId}/logs/stream`,
      });

      // Publish live chunk and end event shortly after connection
      setTimeout(async () => {
        await publishLogChunk(jobId, {
          jobId,
          stream: 'stdout',
          data: 'Live streamed line\n',
          timestamp: new Date().toISOString(),
          attempt: 1,
        });
        await publishLogEnd(jobId, {
          jobId,
          event: 'end',
          exitCode: 0,
          durationMs: 50,
        });
      }, 100);

      const streamRes = await streamPromise;
      expect(streamRes.statusCode).toBe(200);
      expect(streamRes.headers['content-type']).toContain('text/event-stream');
      expect(streamRes.body).toContain('Initial buffered line');
      expect(streamRes.body).toContain('Live streamed line');
      expect(streamRes.body).toContain('"event":"end"');

      await clearBufferedLogs(jobId);
    });
  });
});


