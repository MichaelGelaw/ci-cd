import type { FastifyPluginAsync } from 'fastify';
import { getSystemStats } from '@mini-ci/db';

export const statsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/stats', async (_request, reply) => {
    try {
      const stats = await getSystemStats();
      return reply.status(200).send({ stats });
    } catch (err) {
      return reply.status(500).send({
        error: {
          message: (err as Error).message,
          code: 'INTERNAL_ERROR',
        },
      });
    }
  });
};
