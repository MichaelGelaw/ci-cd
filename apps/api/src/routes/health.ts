import type { FastifyPluginAsync } from 'fastify';
import { query } from '@mini-ci/db';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async (_request, reply) => {
    try {
      await query('SELECT 1;');
      return reply.status(200).send({
        status: 'ok',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return reply.status(503).send({
        status: 'degraded',
        database: 'disconnected',
        error: (err as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  });
};
