import type { FastifyPluginAsync } from 'fastify';
import { Scheduler } from '@mini-ci/scheduler';

export const schedulerRoutes: FastifyPluginAsync = async (app) => {
  app.post('/scheduler/tick', async (_request, reply) => {
    const scheduler = new Scheduler();
    const scheduled = await scheduler.scheduleRound();
    return reply.status(200).send({ scheduled });
  });
};
