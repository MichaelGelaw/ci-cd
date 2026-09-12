import type { FastifyPluginAsync } from 'fastify';
import { getJobDetails, cancelJob, getAttempts } from '../services/job-service.js';

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.get('/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await getJobDetails(id);

    if (!job) {
      return reply.status(404).send({
        error: {
          message: `Job ${id} not found`,
          code: 'NOT_FOUND',
        },
      });
    }

    return reply.status(200).send({ job });
  });

  app.post('/jobs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const job = await cancelJob(id);
      return reply.status(200).send({ job });
    } catch (err) {
      const message = (err as Error).message;

      if (message.includes('not found')) {
        return reply.status(404).send({
          error: {
            message,
            code: 'NOT_FOUND',
          },
        });
      }

      if (message.includes('Invalid job state transition')) {
        return reply.status(400).send({
          error: {
            message,
            code: 'INVALID_TRANSITION',
          },
        });
      }

      return reply.status(500).send({
        error: {
          message,
          code: 'INTERNAL_ERROR',
        },
      });
    }
  });

  app.get('/jobs/:id/attempts', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const attempts = await getAttempts(id);
      return reply.status(200).send({ attempts });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        return reply.status(404).send({
          error: {
            message,
            code: 'NOT_FOUND',
          },
        });
      }

      return reply.status(500).send({
        error: {
          message,
          code: 'INTERNAL_ERROR',
        },
      });
    }
  });
};
