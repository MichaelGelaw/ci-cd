import type { FastifyPluginAsync } from 'fastify';
import { listAllArtifacts } from '@mini-ci/db';
import {
  uploadArtifactService,
  getJobArtifactsService,
  getWorkflowRunArtifactsService,
  getArtifactDetailsService,
  getArtifactStreamService,
  deleteArtifactService,
} from '../services/artifact-service.js';

export const artifactRoutes: FastifyPluginAsync = async (app) => {
  app.post('/jobs/:id/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      if (request.isMultipart && request.isMultipart()) {
        const part = await request.file();
        if (!part) {
          return reply.status(400).send({
            error: {
              message: 'Missing file upload in multipart request',
              code: 'INVALID_REQUEST',
            },
          });
        }

        const nameField = (part.fields['name'] as { value?: string } | undefined)?.value;
        const pathField = (part.fields['path'] as { value?: string } | undefined)?.value;
        const artifactName = nameField || part.filename || 'artifact.bin';
        const logicalPath = pathField || part.filename || artifactName;

        const artifact = await uploadArtifactService({
          jobId: id,
          name: artifactName,
          path: logicalPath,
          mimeType: part.mimetype,
          content: await part.toBuffer(),
        });

        return reply.status(201).send({ artifact });
      }

      // Raw binary / octet-stream upload
      const nameHeader = request.headers['x-artifact-name'] as string | undefined;
      const pathHeader = request.headers['x-artifact-path'] as string | undefined;
      const artifactName = nameHeader || 'artifact.bin';
      const logicalPath = pathHeader || artifactName;
      const mimeType = (request.headers['content-type'] as string) || 'application/octet-stream';

      let contentSource: NodeJS.ReadableStream | Buffer;
      if (Buffer.isBuffer(request.body)) {
        contentSource = request.body;
      } else if (typeof request.body === 'string') {
        contentSource = Buffer.from(request.body, 'utf-8');
      } else {
        return reply.status(400).send({
          error: { message: 'Use multipart or an octet-stream body to upload artifacts', code: 'INVALID_REQUEST' },
        });
      }

      const artifact = await uploadArtifactService({
        jobId: id,
        name: artifactName,
        path: logicalPath,
        mimeType,
        content: contentSource,
      });

      return reply.status(201).send({ artifact });
    } catch (err) {
      if (err instanceof Error && 'statusCode' in err && err.statusCode === 413) {
        return reply.status(413).send({ error: { message: err.message, code: 'ARTIFACT_TOO_LARGE' } });
      }
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

  app.get('/jobs/:id/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const artifacts = await getJobArtifactsService(id);
      return reply.status(200).send({ artifacts, count: artifacts.length });
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

  app.get('/workflow-runs/:id/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const artifacts = await getWorkflowRunArtifactsService(id);
      return reply.status(200).send({ artifacts, count: artifacts.length });
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

  app.get('/artifacts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const artifact = await getArtifactDetailsService(id);

    if (!artifact) {
      return reply.status(404).send({
        error: {
          message: `Artifact ${id} not found`,
          code: 'NOT_FOUND',
        },
      });
    }

    return reply.status(200).send({ artifact });
  });

  app.get('/artifacts/:id/download', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const result = await getArtifactStreamService(id);
      if (!result) {
        return reply.status(404).send({
          error: {
            message: `Artifact ${id} not found`,
            code: 'NOT_FOUND',
          },
        });
      }

      reply.header('Content-Type', result.artifact.mime_type || 'application/octet-stream');
      const filename = encodeURIComponent(result.artifact.name).replace(/['()*]/g, (char) =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Length', result.artifact.size_bytes);

      return reply.send(result.stream);
    } catch (err) {
      const message = (err as Error).message;
      return reply.status(500).send({
        error: {
          message,
          code: 'INTERNAL_ERROR',
        },
      });
    }
  });

  app.delete('/artifacts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const success = await deleteArtifactService(id);
    if (!success) {
      return reply.status(404).send({
        error: {
          message: `Artifact ${id} not found`,
          code: 'NOT_FOUND',
        },
      });
    }

    return reply.status(200).send({ success: true });
  });

  app.get('/artifacts', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number(query['limit'] ?? 50), 1), 100);
    const offset = Math.max(Number(query['offset'] ?? 0), 0);

    const artifacts = await listAllArtifacts(limit, offset);
    return reply.status(200).send({ artifacts, limit, offset });
  });
};
