import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

describe('Milestone 23: Security Hardening (Authentication & Rate Limiting)', () => {
  let app: FastifyInstance;
  const originalApiKey = process.env.MINI_CI_API_KEY;
  const originalRateMax = process.env.RATE_LIMIT_MAX;
  const originalRateWindow = process.env.RATE_LIMIT_WINDOW_MS;

  afterEach(async () => {
    process.env.MINI_CI_API_KEY = originalApiKey;
    process.env.RATE_LIMIT_MAX = originalRateMax;
    process.env.RATE_LIMIT_WINDOW_MS = originalRateWindow;
    if (app) {
      await app.close();
    }
  });

  describe('Permissive Authentication Mode (Default)', () => {
    beforeEach(async () => {
      delete process.env.MINI_CI_API_KEY;
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
  });

  describe('Enforced Authentication Mode (MINI_CI_API_KEY set)', () => {
    const TEST_API_KEY = 'secret-test-token-12345';

    beforeEach(async () => {
      process.env.MINI_CI_API_KEY = TEST_API_KEY;
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
      delete process.env.MINI_CI_API_KEY;
      process.env.RATE_LIMIT_MAX = '5';
      process.env.RATE_LIMIT_WINDOW_MS = '5000';
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
