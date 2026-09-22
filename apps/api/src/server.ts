import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import multipart from '@fastify/multipart';
import { healthRoutes } from './routes/health.js';
import { workflowRoutes } from './routes/workflows.js';
import { jobRoutes } from './routes/jobs.js';
import { workerRoutes } from './routes/workers.js';
import { schedulerRoutes } from './routes/scheduler.js';
import { artifactRoutes } from './routes/artifacts.js';
import { repositoryRoutes } from './routes/repositories.js';
import { webhookRoutes } from './routes/webhooks.js';
import { statsRoutes } from './routes/stats.js';
import { metricsRoutes } from './routes/metrics.js';
import { recordHttpRequest } from './metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    startTime?: [number, number];
    rawBody?: string | Buffer;
  }
}

export function buildServer(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = fastify({
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const headerVal = req.headers['x-request-id'];
      if (typeof headerVal === 'string' && headerVal.trim() !== '') {
        return headerVal.trim();
      }
      return randomUUID();
    },
    ...opts,
  });

  // Enable CORS for dashboard and browser clients
  app.addHook('onRequest', async (req, reply) => {
    req.startTime = process.hrtime();
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Api-Key, X-Hub-Signature-256, X-GitHub-Event, X-Artifact-Name, X-Artifact-Path, X-Request-Id',
    );
    reply.header('Access-Control-Expose-Headers', 'X-Request-Id');
    if (req.method === 'OPTIONS') {
      reply.status(200).send();
    }
  });

  // In-memory sliding-window rate limiter with periodic cleanup
  const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
  const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX || '1000', 10);
  const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
  let lastRateLimitCleanup = Date.now();

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') {
      return;
    }

    const ip = req.ip || '127.0.0.1';
    const now = Date.now();

    // Evict expired entries if interval elapsed or map grows large
    if (now - lastRateLimitCleanup > rateLimitWindowMs || rateLimitStore.size > 5000) {
      lastRateLimitCleanup = now;
      for (const [k, v] of rateLimitStore.entries()) {
        if (now > v.resetAt) {
          rateLimitStore.delete(k);
        }
      }
    }

    let clientLimit = rateLimitStore.get(ip);

    if (!clientLimit || now > clientLimit.resetAt) {
      clientLimit = { count: 1, resetAt: now + rateLimitWindowMs };
      rateLimitStore.set(ip, clientLimit);
    } else {
      clientLimit.count++;
    }

    const remaining = Math.max(0, rateLimitMax - clientLimit.count);
    reply.header('X-RateLimit-Limit', rateLimitMax.toString());
    reply.header('X-RateLimit-Remaining', remaining.toString());
    reply.header('X-RateLimit-Reset', Math.ceil(clientLimit.resetAt / 1000).toString());

    if (clientLimit.count > rateLimitMax) {
      reply.status(429).send({
        error: {
          message: 'Rate limit exceeded. Try again later.',
          code: 'RATE_LIMIT_EXCEEDED',
        },
      });
      return;
    }
  });

  // API Key Authentication (active only when MINI_CI_API_KEY is configured)
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') {
      return;
    }

    const configuredApiKey = process.env.MINI_CI_API_KEY?.trim();
    if (!configuredApiKey) {
      return; // Permissive mode when no API key is configured
    }

    const urlPath = req.url.split('?')[0] || '';
    const isExempt =
      urlPath === '/health' ||
      urlPath === '/health/ready' ||
      urlPath === '/metrics' ||
      urlPath.startsWith('/webhooks');

    if (isExempt) {
      return;
    }

    const authHeader = req.headers.authorization;
    let providedKey: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedKey = authHeader.slice(7).trim();
    } else if (typeof req.headers['x-api-key'] === 'string') {
      providedKey = req.headers['x-api-key'].trim();
    }

    if (!providedKey || providedKey !== configuredApiKey) {
      reply.status(401).send({
        error: {
          message: 'Unauthorized: invalid or missing API key',
          code: 'UNAUTHORIZED',
        },
      });
      return;
    }
  });

  // Echo request id in response headers
  app.addHook('onSend', async (request, reply) => {
    if (request.id) {
      reply.header('x-request-id', request.id);
    }
  });

  // Record Prometheus HTTP metrics
  app.addHook('onResponse', async (request, reply) => {
    const startTime = request.startTime;
    if (startTime) {
      const diff = process.hrtime(startTime);
      const durationSeconds = diff[0] + diff[1] / 1e9;
      const route = request.routeOptions?.url || '/unmatched';
      recordHttpRequest(request.method, route, reply.statusCode, durationSeconds);
    }
  });

  // Register multipart plugin for file uploads
  app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB
    },
  });

  // Preserve raw JSON string on request object for HMAC verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      try {
        req.rawBody = body;
        if (!body || (body as string).trim() === '') {
          done(null, {});
          return;
        }
        const json = JSON.parse(body as string);
        done(null, json);
      } catch (error) {
        done(Object.assign(error as Error, { statusCode: 400 }), undefined);
      }
    },
  );

  // Accept raw YAML and plain text payloads
  app.addContentTypeParser(
    ['application/x-yaml', 'text/yaml', 'text/plain'],
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // Accept raw binary octet-stream payloads
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // Consistent 404 handler
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        message: `Route ${request.method} ${request.url} not found`,
        code: 'NOT_FOUND',
      },
    });
  });

  // Standardized error handler
  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: {
        message: error.message,
        code: error.code ?? 'INTERNAL_SERVER_ERROR',
      },
    });
  });

  // Register route groups
  app.register(healthRoutes);
  app.register(workflowRoutes);
  app.register(jobRoutes);
  app.register(workerRoutes);
  app.register(schedulerRoutes);
  app.register(artifactRoutes);
  app.register(repositoryRoutes);
  app.register(webhookRoutes);
  app.register(statsRoutes);
  app.register(metricsRoutes);

  return app;
}
