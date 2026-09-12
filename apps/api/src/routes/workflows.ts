import type { FastifyPluginAsync } from 'fastify';
import type { WorkflowDefinition } from '@mini-ci/types';
import { submitWorkflow, getRunDetails, listRuns, cancelWorkflowRunService } from '../services/workflow-service.js';

export const workflowRoutes: FastifyPluginAsync = async (app) => {
  app.post('/workflows/runs', async (request, reply) => {
    let input: string | WorkflowDefinition;

    if (typeof request.body === 'string') {
      input = request.body;
    } else if (request.body && typeof request.body === 'object') {
      const body = request.body as Record<string, unknown>;
      if (typeof body['yaml'] === 'string') {
        input = body['yaml'];
      } else if (body['workflow'] && typeof body['workflow'] === 'object') {
        input = body['workflow'] as WorkflowDefinition;
      } else if ('name' in body && 'steps' in body) {
        input = body as unknown as WorkflowDefinition;
      } else {
        return reply.status(400).send({
          error: {
            message: 'Request body must be YAML string, or JSON containing "yaml" or "workflow"',
            code: 'INVALID_REQUEST_BODY',
          },
        });
      }
    } else {
      return reply.status(400).send({
        error: {
          message: 'Request body is required',
          code: 'MISSING_REQUEST_BODY',
        },
      });
    }

    try {
      const result = await submitWorkflow(input);
      return reply.status(201).send(result);
    } catch (err) {
      return reply.status(400).send({
        error: {
          message: (err as Error).message,
          code: 'VALIDATION_ERROR',
        },
      });
    }
  });

  app.get('/workflow-runs', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(query['limit'] ?? 20), 1), 100);
    const offset = Math.max(Number(query['offset'] ?? 0), 0);

    const runs = await listRuns(limit, offset);
    return reply.status(200).send({ runs, limit, offset });
  });

  app.get('/workflow-runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const details = await getRunDetails(id);

    if (!details) {
      return reply.status(404).send({
        error: {
          message: `Workflow run ${id} not found`,
          code: 'NOT_FOUND',
        },
      });
    }

    return reply.status(200).send(details);
  });

  app.post('/workflow-runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;

    try {
      const result = await cancelWorkflowRunService(id, reason);
      return reply.status(200).send({
        run: result.run,
        workflowRun: result.run,
        cancelledJobs: result.cancelledJobs,
      });
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
};
