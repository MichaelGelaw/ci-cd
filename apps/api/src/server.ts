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

export function buildServer(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = fastify(opts);

  // Enable CORS for dashboard and browser clients
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Hub-Signature-256, X-GitHub-Event, X-Artifact-Name, X-Artifact-Path',
    );
    if (req.method === 'OPTIONS') {
      reply.status(200).send();
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
        (req as any).rawBody = body;
        if (!body || (body as string).trim() === '') {
          done(null, {});
          return;
        }
        const json = JSON.parse(body as string);
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
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

  return app;
}
