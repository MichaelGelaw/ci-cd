import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runMigrations, closePool, createWorkflowRun, createJob, registerWorker } from '@mini-ci/db';
import { closeRedis, clearQueue, enqueueJob } from '@mini-ci/queue';
import { buildServer } from '../src/server.js';
import { register } from '../src/metrics.js';

describe('Observability: Prometheus Metrics and Request Tracing', () => {
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

  it('GET /metrics returns 200 with Prometheus text format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const text = res.body;

    // Check presence of Prometheus comments and metric declarations
    expect(text).toContain('# HELP minici_http_requests_total');
    expect(text).toContain('# TYPE minici_http_requests_total counter');
    expect(text).toContain('# HELP minici_http_request_duration_seconds');
    expect(text).toContain('# TYPE minici_http_request_duration_seconds histogram');
    expect(text).toContain('# HELP minici_workflows_total');
    expect(text).toContain('# HELP minici_jobs_total');
    expect(text).toContain('# HELP minici_active_workers');
    expect(text).toContain('# HELP minici_queue_jobs_waiting');
  });

  it('generates x-request-id when not supplied by client', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const reqId = res.headers['x-request-id'];
    expect(reqId).toBeDefined();
    expect(typeof reqId).toBe('string');
    expect((reqId as string).length).toBeGreaterThan(0);
  });

  it('preserves x-request-id when supplied by client for correlation', async () => {
    const customReqId = 'trace-corr-12345-abcde';
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': customReqId,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe(customReqId);
  });

  it('tracks HTTP requests and latency in Prometheus metrics', async () => {
    // Send a request to an endpoint
    const healthRes = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(healthRes.statusCode).toBe(200);

    const metricsRes = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(metricsRes.statusCode).toBe(200);
    const text = metricsRes.body;

    // Verify counter incremented for /health
    expect(text).toMatch(/minici_http_requests_total\{method="GET",route="\/health",status_code="200"\}\s+[1-9]\d*/);
    // Verify duration histogram bucket is recorded
    expect(text).toMatch(/minici_http_request_duration_seconds_count\{method="GET",route="\/health",status_code="200"\}\s+[1-9]\d*/);
  });

  it('records workflow creation and cancellation metrics', async () => {
    const yamlContent = `
name: metrics-workflow-test
jobs:
  test:
    run: echo "metrics test"
`;

    // Submit workflow
    const submitRes = await app.inject({
      method: 'POST',
      url: '/workflows/runs',
      payload: { yaml: yamlContent },
    });
    expect(submitRes.statusCode).toBe(201);
    const runId = submitRes.json().run.id;

    // Cancel workflow
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/workflow-runs/${runId}/cancel`,
      payload: { reason: 'test cancel metrics' },
    });
    expect(cancelRes.statusCode).toBe(200);

    const metricsRes = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    const text = metricsRes.body;

    expect(text).toMatch(/minici_workflows_total\{status="running",trigger_event="manual"\}\s+[1-9]\d*/);
    expect(text).toMatch(/minici_workflows_total\{status="cancelled",trigger_event="manual"\}\s+[1-9]\d*/);
  });

  it('records job execution status transitions and duration', async () => {
    const run = await createWorkflowRun('metrics-job-run', 'running');
    const job = await createJob({
      workflowRunId: run.id,
      name: 'metrics-exec-job',
      command: 'echo 42',
      status: 'queued',
    });

    // Update job status: queued -> assigned
    await app.inject({
      method: 'POST',
      url: `/jobs/${job.id}/status`,
      payload: { status: 'assigned', worker_id: 'worker-metrics-1' },
    });

    // Update job status: assigned -> running
    await app.inject({
      method: 'POST',
      url: `/jobs/${job.id}/status`,
      payload: { status: 'running', worker_id: 'worker-metrics-1' },
    });

    // Update job status to succeeded with duration
    await app.inject({
      method: 'POST',
      url: `/jobs/${job.id}/status`,
      payload: {
        status: 'succeeded',
        worker_id: 'worker-metrics-1',
        exit_code: 0,
        duration_ms: 1500,
      },
    });

    const metricsRes = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    const text = metricsRes.body;

    expect(text).toMatch(/minici_jobs_total\{status="running"\}\s+[1-9]\d*/);
    expect(text).toMatch(/minici_jobs_total\{status="succeeded"\}\s+[1-9]\d*/);
    expect(text).toMatch(/minici_job_duration_seconds_count\{status="succeeded"\}\s+[1-9]\d*/);
  });

  it('records worker registration and heartbeat metrics', async () => {
    const workerId = `worker-obs-${Date.now()}`;

    // Register worker
    const regRes = await app.inject({
      method: 'POST',
      url: '/workers/register',
      payload: {
        id: workerId,
        name: 'test-obs-worker',
        tags: ['linux', 'docker'],
      },
    });
    expect(regRes.statusCode).toBe(200);

    // Touch heartbeat
    const hbRes = await app.inject({
      method: 'POST',
      url: `/workers/${workerId}/heartbeat`,
      payload: { status: 'ready' },
    });
    expect(hbRes.statusCode).toBe(200);

    const metricsRes = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    const text = metricsRes.body;

    expect(text).toMatch(/minici_workers_registered_total\s+[1-9]\d*/);
    expect(text).toMatch(/minici_worker_heartbeats_total\{status="ready"\}\s+[1-9]\d*/);
  });

  it('updates queue and active worker gauges on metric scrape', async () => {
    const dummyWorkerId = `gauge-worker-${Date.now()}`;
    await registerWorker({
      id: dummyWorkerId,
      name: 'gauge-worker',
    });

    await enqueueJob({
      jobId: 'dummy-gauge-job-1',
      workflowRunId: 'dummy-run-1',
      queuedAt: new Date().toISOString(),
      attempt: 1,
    });

    const metricsRes = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(metricsRes.statusCode).toBe(200);
    const text = metricsRes.body;

    expect(text).toMatch(/minici_queue_jobs_waiting\s+[1-9]\d*/);
    expect(text).toMatch(/minici_active_workers\{status="ready"\}\s+[1-9]\d*/);
  });
});
