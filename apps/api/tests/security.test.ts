import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { runMigrations, closePool } from '@mini-ci/db';
import { closeRedis } from '@mini-ci/queue';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

describe('Milestone 23: Security Hardening (Authentication & Rate Limiting)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closePool(); await closeRedis(); });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (app) {
      await app.close();
    }
  });

  describe('Permissive Authentication Mode (Default)', () => {
    beforeEach(async () => {
      vi.stubEnv('MINI_CI_API_KEY', '');
      app = buildServer();
      await app.ready();
    });

    it('allows access to protected routes when MINI_CI_API_KEY is not set', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workers',
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows access to public health endpoints', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });
      expect(res.statusCode).toBe(200);
    });

    it('does not execute workflow commands supplied by webhook payloads', async () => {
      const res = await app.inject({
        method: 'POST', url: '/webhooks/github',
        headers: { 'x-github-event': 'push' },
        payload: {
          repository: { full_name: 'unregistered/inline-command' },
          workflow: 'name: injected\nsteps:\n  - run: echo injected',
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().triggered).toBe(0);
    });

    it('returns a client error for malformed JSON', async () => {
      const res = await app.inject({
        method: 'POST', url: '/workflows/runs',
        headers: { 'content-type': 'application/json' }, payload: '{',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('Enforced Authentication Mode (MINI_CI_API_KEY set)', () => {
    const TEST_API_KEY = 'secret-test-token-12345';

    beforeEach(async () => {
      vi.stubEnv('MINI_CI_API_KEY', TEST_API_KEY);
      app = buildServer();
      await app.ready();
    });

    it('rejects unauthenticated requests to protected routes with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workers',
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('rejects unsigned webhook triggers when API authentication is enabled', async () => {
      const res = await app.inject({
        method: 'POST', url: '/webhooks/github',
        headers: { 'x-github-event': 'push' },
        payload: { repository: { full_name: 'unregistered/unsigned' } },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects requests with invalid API key with 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workers',
        headers: {
          authorization: 'Bearer wrong-key',
        },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('allows authenticated requests with Bearer token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workers',
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows authenticated requests with x-api-key header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workers',
        headers: {
          'x-api-key': TEST_API_KEY,
        },
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows unauthenticated access to /health and /metrics even when auth is enforced', async () => {
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
    });
  });

  describe('Rate Limiting', () => {
    beforeEach(async () => {
      vi.stubEnv('MINI_CI_API_KEY', '');
      vi.stubEnv('RATE_LIMIT_MAX', '5');
      vi.stubEnv('RATE_LIMIT_WINDOW_MS', '5000');
      app = buildServer();
      await app.ready();
    });

    it('includes rate limit headers on responses', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('5');
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    });

    it('blocks requests and returns 429 when rate limit is exceeded', async () => {
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'GET',
          url: '/health',
        });
        expect(res.statusCode).toBe(200);
      }

      // 6th request must breach the limit
      const blockedRes = await app.inject({
        method: 'GET',
        url: '/health',
      });
      expect(blockedRes.statusCode).toBe(429);
      const body = blockedRes.json();
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    });
  });
});
