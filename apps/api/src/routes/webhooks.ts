import type { FastifyPluginAsync } from 'fastify';
import { processGitHubWebhook, InvalidSignatureError } from '../services/webhook-service.js';
import { recordWebhook } from '../metrics.js';

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.post('/webhooks/github', async (request, reply) => {
    const eventHeader = request.headers['x-github-event'];
    const signatureHeader = request.headers['x-hub-signature-256'] as string | undefined;

    if (!eventHeader || typeof eventHeader !== 'string') {
      return reply.status(400).send({
        error: {
          message: 'Missing or invalid X-GitHub-Event header',
          code: 'MISSING_HEADER',
        },
      });
    }

    const rawBody = (request as any).rawBody ?? JSON.stringify(request.body ?? {});
    const payload = (request.body ?? {}) as Record<string, unknown>;

    try {
      const result = await processGitHubWebhook({
        event: eventHeader,
        signature: signatureHeader,
        rawBody,
        payload,
      });

      recordWebhook(eventHeader, result.status);

      if (result.status === 'pong') {
        return reply.status(200).send({
          message: 'pong',
          zen: result.zen,
        });
      }

      if (result.status === 'ignored') {
        return reply.status(200).send({
          message: result.reason ?? 'Event ignored',
          event: result.event,
          repository: result.repository,
          triggered: 0,
          runs: [],
        });
      }

      return reply.status(201).send({
        message: `Successfully triggered ${result.matchedWorkflows} workflow(s)`,
        event: result.event,
        repository: result.repository,
        triggered: result.matchedWorkflows,
        runs: result.runs,
      });
    } catch (err) {
      recordWebhook(eventHeader, 'error');
      if (err instanceof InvalidSignatureError) {
        return reply.status(401).send({
          error: {
            message: err.message,
            code: err.code,
          },
        });
      }

      const msg = (err as Error).message;
      if (msg.includes('Missing repository')) {
        return reply.status(400).send({
          error: {
            message: msg,
            code: 'INVALID_PAYLOAD',
          },
        });
      }

      return reply.status(500).send({
        error: {
          message: msg,
          code: 'INTERNAL_ERROR',
        },
      });
    }
  });
};
