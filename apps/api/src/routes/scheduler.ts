import type { FastifyPluginAsync } from 'fastify';
import { Scheduler } from '@mini-ci/scheduler';
import { dispatchDueRetries, recoverStaleJobsService } from '../services/job-service.js';

export const schedulerRoutes: FastifyPluginAsync = async (app) => {
  app.post('/scheduler/tick', async (_request, reply) => {
    const recovered = await recoverStaleJobsService();
    const retried = await dispatchDueRetries();
    const scheduler = new Scheduler();
    const scheduled = await scheduler.scheduleRound();
    return reply.status(200).send({ scheduled, retried, recovered });
  });
};

