import type { FastifyPluginAsync } from 'fastify';
import type { JobStatus } from '@mini-ci/types';
import {
  getJobDetails,
  cancelJob,
  getAttempts,
  updateJobExecutionStatus,
  renewJobLeaseService,
  findExpiredLeasesService,
  LeaseConflictError,
} from '../services/job-service.js';

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.get('/jobs/leases/expired', async (request, reply) => {
    const query = (request.query ?? {}) as { grace_period_seconds?: string };
    const gracePeriodSeconds = query.grace_period_seconds
      ? parseInt(query.grace_period_seconds, 10)
      : 0;

    try {
      const jobs = await findExpiredLeasesService(gracePeriodSeconds);
      return reply.status(200).send({ jobs, count: jobs.length });
    } catch (err) {
      const message = (err as Error).message;
      return reply.status(500).send({
        error: {
          message,
          code: 'INTERNAL_ERROR',
        },
      });
    }
  });

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

  app.post('/jobs/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (!body['status'] || typeof body['status'] !== 'string') {
      return reply.status(400).send({
        error: {
          message: 'Missing or invalid "status" field in request body',
          code: 'INVALID_REQUEST_BODY',
        },
      });
    }

    try {
      const job = await updateJobExecutionStatus(id, {
        status: body['status'] as JobStatus,
        workerId: typeof body['worker_id'] === 'string' ? body['worker_id'] : undefined,
        exitCode: typeof body['exit_code'] === 'number' ? body['exit_code'] : undefined,
        stdout: typeof body['stdout'] === 'string' ? body['stdout'] : undefined,
        stderr: typeof body['stderr'] === 'string' ? body['stderr'] : undefined,
        error: typeof body['error'] === 'string' ? body['error'] : undefined,
        durationMs: typeof body['duration_ms'] === 'number' ? body['duration_ms'] : undefined,
      });

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

  app.post('/jobs/:id/lease/renew', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (!body['lease_token'] || typeof body['lease_token'] !== 'string') {
      return reply.status(400).send({
        error: {
          message: 'Missing or invalid "lease_token" field in request body',
          code: 'INVALID_REQUEST_BODY',
        },
      });
    }

    const durationSeconds =
      typeof body['duration_seconds'] === 'number'
        ? body['duration_seconds']
        : undefined;

    try {
      const result = await renewJobLeaseService(id, {
        lease_token: body['lease_token'] as string,
        duration_seconds: durationSeconds,
      });

      return reply.status(200).send(result);
    } catch (err) {
      const message = (err as Error).message;

      if (err instanceof LeaseConflictError) {
        return reply.status(409).send({
          error: {
            message,
            code: 'LEASE_CONFLICT',
          },
        });
      }

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

