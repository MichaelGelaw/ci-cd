import type { FastifyPluginAsync } from 'fastify';
import type { JobStatus, LogEvent } from '@mini-ci/types';
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
import {
  getJobLogsService,
  getBufferedLogs,
  subscribeJobLogs,
} from '../services/log-service.js';
import { recordJobStatus } from '../metrics.js';

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

  app.get('/jobs/:id/logs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as Record<string, unknown>;
    const format = String(query['format'] ?? 'json');
    const streamFilter = String(query['stream'] ?? 'all');

    const result = await getJobLogsService(id);
    if (!result) {
      return reply.status(404).send({
        error: {
          message: `Job ${id} not found`,
          code: 'NOT_FOUND',
        },
      });
    }

    if (format === 'text') {
      let output = '';
      if (streamFilter === 'stdout') {
        output = result.stdout;
      } else if (streamFilter === 'stderr') {
        output = result.stderr;
      } else {
        output = result.stdout + (result.stderr ? '\n' + result.stderr : '');
      }
      return reply.type('text/plain').send(output);
    }

    let filteredEvents = result.events;
    if (streamFilter === 'stdout') {
      filteredEvents = result.events.filter((e) => 'stream' in e && e.stream === 'stdout');
    } else if (streamFilter === 'stderr') {
      filteredEvents = result.events.filter((e) => 'stream' in e && e.stream === 'stderr');
    }

    return reply.status(200).send({
      jobId: result.jobId,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      events: filteredEvents,
      count: filteredEvents.length,
    });
  });

  app.get('/jobs/:id/logs/stream', async (request, reply) => {
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

    let closed = false;
    let replaying = true;
    const pending: LogEvent[] = [];
    let unsubscribe: (() => Promise<void>) | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      void unsubscribe?.().catch(() => {});
      reply.raw.end();
    };
    reply.raw.on('close', close);

    const sendEvent = (event: LogEvent) => {
      if (closed) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if ('event' in event && event.event === 'end') close();
    };

    try {
      // Subscribe before reading the buffer so events cannot fall between replay and live delivery.
      unsubscribe = await subscribeJobLogs(id, (event) => {
        if (replaying) pending.push(event);
        else sendEvent(event);
      });
      if (closed) {
        await unsubscribe();
        return;
      }
      const buffered = await getBufferedLogs(id);
      const currentJob = await getJobDetails(id) ?? job;
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      reply.raw.flushHeaders();

      const replayCounts = new Map<string, number>();
      for (const event of buffered) {
        // An older attempt's end marker must not close the current attempt's stream.
        if ('event' in event && event.event === 'end' &&
            event.attempt !== undefined && event.attempt !== currentJob.attempt) continue;
        const key = JSON.stringify(event);
        replayCounts.set(key, (replayCounts.get(key) ?? 0) + 1);
        sendEvent(event);
      }
      replaying = false;
      for (const event of pending) {
        const key = JSON.stringify(event);
        const count = replayCounts.get(key) ?? 0;
        if (count > 0) replayCounts.set(key, count - 1);
        else sendEvent(event);
      }
      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(currentJob.status)) {
        sendEvent({ jobId: id, event: 'end', exitCode: currentJob.exit_code });
      }
    } catch (error) {
      await unsubscribe?.().catch(() => {});
      if (reply.raw.headersSent) close();
      else throw error;
    }
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
        leaseToken: typeof body['lease_token'] === 'string' ? body['lease_token'] : undefined,
        exitCode: typeof body['exit_code'] === 'number' ? body['exit_code'] : undefined,
        stdout: typeof body['stdout'] === 'string' ? body['stdout'] : undefined,
        stderr: typeof body['stderr'] === 'string' ? body['stderr'] : undefined,
        error: typeof body['error'] === 'string' ? body['error'] : undefined,
        durationMs: typeof body['duration_ms'] === 'number' ? body['duration_ms'] : undefined,
      });

      recordJobStatus(
        body['status'] as string,
        typeof body['duration_ms'] === 'number' ? body['duration_ms'] / 1000 : undefined,
      );

      return reply.status(200).send({ job });
    } catch (err) {
      const message = (err as Error).message;

      if (err instanceof LeaseConflictError) {
        return reply.status(409).send({ error: { message, code: 'LEASE_CONFLICT' } });
      }

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
    const body = (request.body ?? {}) as Record<string, unknown>;
    const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;

    try {
      const job = await cancelJob(id, reason);
      recordJobStatus('cancelled');
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
