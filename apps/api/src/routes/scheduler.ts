import type { FastifyPluginAsync } from 'fastify';
import { Scheduler } from '@mini-ci/scheduler';
import { dispatchDueRetries, recoverStaleJobsService } from '../services/job-service.js';
import { recordSchedulerCycle } from '../metrics.js';

export const schedulerRoutes: FastifyPluginAsync = async (app) => {
  app.post('/scheduler/tick', async (_request, reply) => {
    const start = process.hrtime();
    try {
      const recovered = await recoverStaleJobsService();
      const retried = await dispatchDueRetries();
      const scheduler = new Scheduler();
      const scheduled = await scheduler.scheduleRound();
      const diff = process.hrtime(start);
      const durationSeconds = diff[0] + diff[1] / 1e9;
      recordSchedulerCycle(scheduled.length, durationSeconds, 'success');
      return reply.status(200).send({ scheduled, retried, recovered });
    } catch (err) {
      const diff = process.hrtime(start);
      const durationSeconds = diff[0] + diff[1] / 1e9;
      recordSchedulerCycle(0, durationSeconds, 'error');
      throw err;
    }
  });
};

