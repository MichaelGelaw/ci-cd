import type { FastifyPluginAsync } from 'fastify';
import {
  createRepository,
  getRepository,
  getRepositoryByName,
  listRepositories,
  deleteRepository,
  createRegisteredWorkflow,
  listRegisteredWorkflows,
} from '@mini-ci/db';
import { parseWorkflowContent } from '../services/workflow-parser.js';

export const repositoryRoutes: FastifyPluginAsync = async (app) => {
  app.post('/repositories', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (typeof body['name'] !== 'string' || body['name'].trim() === '') {
      return reply.status(400).send({
        error: {
          message: 'Repository "name" is required and must be a non-empty string',
          code: 'INVALID_REQUEST_BODY',
        },
      });
    }

    try {
      const repo = await createRepository({
        name: body['name'].trim(),
        url: typeof body['url'] === 'string' ? body['url'].trim() : null,
        default_branch:
          typeof body['default_branch'] === 'string' ? body['default_branch'].trim() : 'main',
        webhook_secret:
          typeof body['webhook_secret'] === 'string' ? body['webhook_secret'] : null,
      });

      return reply.status(201).send({ repository: repo });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('unique') || msg.includes('duplicate')) {
        return reply.status(409).send({
          error: {
            message: `Repository "${body['name']}" already exists`,
            code: 'REPOSITORY_ALREADY_EXISTS',
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

  app.get('/repositories', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(query['limit'] ?? 20), 1), 100);
    const offset = Math.max(Number(query['offset'] ?? 0), 0);

    const repositories = await listRepositories(limit, offset);
    return reply.status(200).send({ repositories, limit, offset });
  });

  app.get('/repositories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = await getRepository(id);

    if (!repo) {
      return reply.status(404).send({
        error: {
          message: `Repository ${id} not found`,
          code: 'NOT_FOUND',
        },
      });
    }

    return reply.status(200).send({ repository: repo });
  });

  app.delete('/repositories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await deleteRepository(id);

    if (!deleted) {
      return reply.status(404).send({
        error: {
          message: `Repository ${id} not found`,
          code: 'NOT_FOUND',
        },
      });
    }

    return reply.status(200).send({ success: true });
  });

  app.post('/repositories/:id/workflows', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = await getRepository(id);

    if (!repo) {
      return reply.status(404).send({
        error: {
          message: `Repository ${id} not found`,
          code: 'NOT_FOUND',
        },
      });
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const content =
      typeof body['content'] === 'string'
        ? body['content']
        : typeof body['yaml'] === 'string'
          ? body['yaml']
          : null;

    if (!content || content.trim() === '') {
      return reply.status(400).send({
        error: {
          message: 'Workflow "content" or "yaml" is required and must be non-empty',
          code: 'INVALID_REQUEST_BODY',
        },
      });
    }

    // Validate workflow YAML syntax
    let parsedName: string;
    try {
      const parsed = parseWorkflowContent(content);
      parsedName = parsed.name;
    } catch (err) {
      return reply.status(400).send({
        error: {
          message: `Invalid workflow content: ${(err as Error).message}`,
          code: 'VALIDATION_ERROR',
        },
      });
    }

    const name =
      typeof body['name'] === 'string' && body['name'].trim() !== ''
        ? body['name'].trim()
        : parsedName;

    const path = typeof body['path'] === 'string' ? body['path'].trim() : undefined;
    const isActive = typeof body['is_active'] === 'boolean' ? body['is_active'] : true;

    const workflow = await createRegisteredWorkflow({
      repositoryId: id,
      name,
      path,
      content,
      isActive,
    });

    return reply.status(201).send({ workflow });
  });

  app.get('/repositories/:id/workflows', async (request, reply) => {
    const { id } = request.params as { id: string };
    const repo = await getRepository(id);

    if (!repo) {
      return reply.status(404).send({
        error: {
          message: `Repository ${id} not found`,
          code: 'NOT_FOUND',
        },
      });
    }

    const query = request.query as Record<string, string | undefined>;
    const onlyActive = query['only_active'] === 'true';

    const workflows = await listRegisteredWorkflows(id, onlyActive);
    return reply.status(200).send({ workflows });
  });
};
