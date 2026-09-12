import fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { healthRoutes } from './routes/health.js';
import { workflowRoutes } from './routes/workflows.js';
import { jobRoutes } from './routes/jobs.js';

export function buildServer(opts: FastifyServerOptions = {}): FastifyInstance {
  const app = fastify(opts);

  // Accept raw YAML and plain text payloads
  app.addContentTypeParser(
    ['application/x-yaml', 'text/yaml', 'text/plain'],
    { parseAs: 'string' },
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
  app.setErrorHandler((error, _request, reply) => {
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

  return app;
}
