import type { FastifyPluginAsync } from 'fastify';
import { query } from '@mini-ci/db';
import { getRedisClient } from '@mini-ci/queue';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_request, reply) => {
    let dbStatus = 'disconnected';
    let redisStatus = 'disconnected';
    let error: string | undefined;

    try {
      await query('SELECT 1;');
      dbStatus = 'connected';
    } catch (err) {
      error = (err as Error).message;
    }

    try {
      const redis = getRedisClient();
      await redis.ping();
      redisStatus = 'connected';
    } catch (err) {
      error = error ? `${error}; ${(err as Error).message}` : (err as Error).message;
    }

    const isHealthy = dbStatus === 'connected' && redisStatus === 'connected';

    return reply.status(isHealthy ? 200 : 503).send({
      status: isHealthy ? 'ok' : 'degraded',
      database: dbStatus,
      redis: redisStatus,
      ...(error ? { error } : {}),
      timestamp: new Date().toISOString(),
    });
  });
};
