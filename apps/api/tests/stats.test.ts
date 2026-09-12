import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runMigrations, closePool, createWorkflowRun, createJob, createRepository } from '@mini-ci/db';
import { closeRedis, clearQueue } from '@mini-ci/queue';
import { buildServer } from '../src/server.js';

describe('System Stats and Global Artifacts API', () => {
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

  it('GET /stats returns aggregated system statistics', async () => {
    const run = await createWorkflowRun('stats-test-run', 'running');
    await createJob({
      workflowRunId: run.id,
      name: 'stats-job',
      command: 'echo 1',
      status: 'queued',
    });
    await createRepository({
      name: `stats-repo-${Date.now()}`,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/stats',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats).toBeDefined();

    // Verify runs metrics structure
    expect(body.stats.runs).toBeDefined();
    expect(body.stats.runs.total).toBeGreaterThanOrEqual(1);
    expect(body.stats.runs.running).toBeGreaterThanOrEqual(1);

    // Verify jobs metrics structure
    expect(body.stats.jobs).toBeDefined();
    expect(body.stats.jobs.total).toBeGreaterThanOrEqual(1);
    expect(body.stats.jobs.queued).toBeGreaterThanOrEqual(1);

    // Verify workers metrics structure
    expect(body.stats.workers).toBeDefined();
    expect(typeof body.stats.workers.total).toBe('number');

    // Verify repositories metrics structure
    expect(body.stats.repositories).toBeDefined();
    expect(body.stats.repositories.total).toBeGreaterThanOrEqual(1);

    // Verify artifacts metrics structure
    expect(body.stats.artifacts).toBeDefined();
    expect(typeof body.stats.artifacts.total).toBe('number');
    expect(typeof body.stats.artifacts.totalBytes).toBe('number');
  });

  it('GET /artifacts returns global paginated list of artifacts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/artifacts?limit=10&offset=0',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.artifacts).toBeDefined();
    expect(Array.isArray(body.artifacts)).toBe(true);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
  });

  it('responds with CORS headers on requests and preflight OPTIONS', async () => {
    const optRes = await app.inject({
      method: 'OPTIONS',
      url: '/stats',
    });

    expect(optRes.statusCode).toBe(200);
    expect(optRes.headers['access-control-allow-origin']).toBe('*');
    expect(optRes.headers['access-control-allow-methods']).toContain('GET');

    const getRes = await app.inject({
      method: 'GET',
      url: '/stats',
    });

    expect(getRes.headers['access-control-allow-origin']).toBe('*');
  });
});
