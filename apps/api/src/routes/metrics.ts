import type { FastifyPluginAsync } from 'fastify';
import { getMetricsText, register } from '../metrics.js';

export const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/metrics', async (_request, reply) => {
    const metrics = await getMetricsText();
    reply.header('Content-Type', register.contentType);
    return reply.send(metrics);
  });
};
