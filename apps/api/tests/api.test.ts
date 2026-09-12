import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runMigrations, closePool } from '@mini-ci/db';
import { closeRedis, clearQueue, getQueueLength } from '@mini-ci/queue';
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
});
