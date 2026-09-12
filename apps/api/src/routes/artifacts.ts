import type { FastifyPluginAsync } from 'fastify';
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
          content: part.file,
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
        contentSource = request.raw;
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
      reply.header('Content-Disposition', `attachment; filename="${result.artifact.name}"`);
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
};