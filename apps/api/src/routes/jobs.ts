import type { FastifyPluginAsync } from 'fastify';
import type { JobStatus } from '@mini-ci/types';
import {
  getJobDetails,
  cancelJob,
  getAttempts,
  updateJobExecutionStatus,
  renewJobLeaseService,
  findExpiredLeasesService,
  dispatchDueRetries,
  findDueRetryingJobsService,
  findRecoverableJobsService,
  recoverJobService,
  recoverStaleJobsService,
  LeaseConflictError,
} from '../services/job-service.js';

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.get('/jobs/recoverable', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const leaseGracePeriod = query['lease_grace_period_seconds']
      ? parseInt(String(query['lease_grace_period_seconds']), 10)
      : undefined;
    const heartbeatTimeout = query['heartbeat_timeout_seconds']
      ? parseInt(String(query['heartbeat_timeout_seconds']), 10)
      : undefined;

    try {
      const recoverableJobs = await findRecoverableJobsService({
        leaseGracePeriodSeconds: leaseGracePeriod,
        heartbeatTimeoutSeconds: heartbeatTimeout,
      });
      return reply.status(200).send({ recoverableJobs, count: recoverableJobs.length });
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

  app.post('/jobs/recover', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const leaseGracePeriod = body['lease_grace_period_seconds'] ?? query['lease_grace_period_seconds']
      ? parseInt(String(body['lease_grace_period_seconds'] ?? query['lease_grace_period_seconds']), 10)
      : undefined;
    const heartbeatTimeout = body['heartbeat_timeout_seconds'] ?? query['heartbeat_timeout_seconds']
      ? parseInt(String(body['heartbeat_timeout_seconds'] ?? query['heartbeat_timeout_seconds']), 10)
      : undefined;

    try {
      const recoveredJobs = await recoverStaleJobsService({
        leaseGracePeriodSeconds: leaseGracePeriod,
        heartbeatTimeoutSeconds: heartbeatTimeout,
      });
      return reply.status(200).send({ recoveredJobs, count: recoveredJobs.length });
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

  app.post('/jobs/:id/recover', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
    const immediate = Boolean(body['immediate'] ?? body['immediate_requeue']);

    try {
      const result = await recoverJobService(id, reason, { immediateRequeue: immediate });
      return reply.status(200).send(result);
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

  app.get('/jobs/retries/due', async (request, reply) => {
    const query = (request.query ?? {}) as { limit?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 100;

    try {
      const dueJobs = await findDueRetryingJobsService(limit);
      return reply.status(200).send({ dueJobs, count: dueJobs.length });
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

  app.post('/jobs/retries/dispatch', async (_request, reply) => {
    try {
      const retried = await dispatchDueRetries();
      return reply.status(200).send({ retried, count: retried.length });
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

