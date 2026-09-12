import type { FastifyPluginAsync } from 'fastify';
import type { WorkerStatus } from '@mini-ci/types';
import {
  registerWorkerService,
  getWorkerService,
  listWorkersService,
  touchWorkerHeartbeatService,
  reapDeadWorkersService,
  findStaleWorkersService,
} from '../services/worker-service.js';

const VALID_WORKER_STATUSES: Set<WorkerStatus> = new Set(['ready', 'busy', 'offline', 'paused']);

export const workerRoutes: FastifyPluginAsync = async (app) => {
  app.post('/workers/register', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (!body['name'] || typeof body['name'] !== 'string' || body['name'].trim().length === 0) {
      return reply.status(400).send({
        error: {
          message: 'Field "name" is required and must be a non-empty string',
          code: 'INVALID_REQUEST_BODY',
        },
      });
    }

    const worker = await registerWorkerService({
      id: typeof body['id'] === 'string' ? body['id'] : '',
      name: body['name'].trim(),
      address: typeof body['address'] === 'string' ? body['address'] : undefined,
      tags: Array.isArray(body['tags']) ? body['tags'].map(String) : undefined,
      metadata:
        typeof body['metadata'] === 'object' && body['metadata'] !== null
          ? (body['metadata'] as Record<string, unknown>)
          : undefined,
    });

    return reply.status(200).send({ worker });
  });

  app.get('/workers', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    let status: WorkerStatus | undefined;

    if (query['status']) {
      const s = String(query['status']);
      if (!VALID_WORKER_STATUSES.has(s as WorkerStatus)) {
        return reply.status(400).send({
          error: {
            message: `Invalid status filter: ${s}. Valid values: ready, busy, offline, paused`,
            code: 'INVALID_QUERY_PARAMETER',
          },
        });
      }
      status = s as WorkerStatus;
    }

    const limit = query['limit'] ? Math.max(1, parseInt(String(query['limit']), 10) || 50) : undefined;
    const offset = query['offset'] ? Math.max(0, parseInt(String(query['offset']), 10) || 0) : undefined;

    const workers = await listWorkersService({ status, limit, offset });
    return reply.status(200).send({ workers });
  });

  app.get('/workers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const worker = await getWorkerService(id);

    if (!worker) {
      return reply.status(404).send({
        error: {
          message: `Worker ${id} not found`,
          code: 'NOT_FOUND',
        },
      });
    }

    return reply.status(200).send({ worker });
  });

  app.post('/workers/:id/heartbeat', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;

    let status: WorkerStatus | undefined;
    if (body['status'] !== undefined) {
      const s = String(body['status']);
      if (!VALID_WORKER_STATUSES.has(s as WorkerStatus)) {
        return reply.status(400).send({
          error: {
            message: `Invalid status: ${s}. Valid values: ready, busy, offline, paused`,
            code: 'INVALID_REQUEST_BODY',
          },
        });
      }
      status = s as WorkerStatus;
    }

    try {
      const worker = await touchWorkerHeartbeatService(id, status);
      return reply.status(200).send({ worker });
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('not found')) {
        return reply.status(404).send({
          error: {
            message: `Worker ${id} not found`,
            code: 'NOT_FOUND',
          },
        });
      }
      throw err;
    }
  });

  app.get('/workers/stale', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const timeout = query['timeout_seconds']
      ? Math.max(1, parseInt(String(query['timeout_seconds']), 10) || 30)
      : 30;

    const staleWorkers = await findStaleWorkersService(timeout);
    return reply.status(200).send({ staleWorkers, count: staleWorkers.length });
  });

  app.post('/workers/reap', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const rawTimeout = body['timeout_seconds'] ?? query['timeout_seconds'] ?? 30;
    const timeout = Math.max(1, parseInt(String(rawTimeout), 10) || 30);

    const reapedWorkers = await reapDeadWorkersService(timeout);
    return reply.status(200).send({ reapedWorkers, count: reapedWorkers.length });
  });
};
