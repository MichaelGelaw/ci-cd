import type { ArtifactRecord } from '@mini-ci/types';
import {
  createArtifact,
  getArtifact,
  getArtifactsByJob,
  getArtifactsByWorkflowRun,
  deleteArtifact,
  getJob,
  getWorkflowRun,
} from '@mini-ci/db';
import { storageService, StorageService } from './storage-service.js';

export interface UploadArtifactOptions {
  jobId: string;
  name: string;
  path?: string;
  mimeType?: string | null;
  content: NodeJS.ReadableStream | Buffer;
}

export async function uploadArtifactService(
  options: UploadArtifactOptions,
  storage: StorageService = storageService,
): Promise<ArtifactRecord> {
  const job = await getJob(options.jobId);
  if (!job) {
    throw new Error(`Job ${options.jobId} not found`);
  }

  const logicalPath = options.path || options.name;
  const filename = options.name;

  const saveResult = await storage.saveArtifact(
    job.workflow_run_id,
    job.id,
    filename,
    options.content,
  );

  return createArtifact({
    jobId: job.id,
    workflowRunId: job.workflow_run_id,
    name: filename,
    path: logicalPath,
    sizeBytes: saveResult.sizeBytes,
    mimeType: options.mimeType ?? null,
    storagePath: saveResult.storagePath,
    checksum: saveResult.checksum,
  });
}

export async function getJobArtifactsService(jobId: string): Promise<ArtifactRecord[]> {
  const job = await getJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }
  return getArtifactsByJob(jobId);
}

export async function getWorkflowRunArtifactsService(runId: string): Promise<ArtifactRecord[]> {
  const run = await getWorkflowRun(runId);
  if (!run) {
    throw new Error(`Workflow run ${runId} not found`);
  }
  return getArtifactsByWorkflowRun(runId);
}

export async function getArtifactDetailsService(id: string): Promise<ArtifactRecord | null> {
  return getArtifact(id);
}

export async function getArtifactStreamService(
  id: string,
  storage: StorageService = storageService,
): Promise<{ artifact: ArtifactRecord; stream: NodeJS.ReadableStream } | null> {
  const artifact = await getArtifact(id);
  if (!artifact) {
    return null;
  }

  const stream = await storage.getArtifactStream(artifact.storage_path);
  return { artifact, stream };
}

export async function deleteArtifactService(
  id: string,
  storage: StorageService = storageService,
): Promise<boolean> {
  const artifact = await getArtifact(id);
  if (!artifact) {
    return false;
  }

  await storage.deleteArtifactFile(artifact.storage_path);
  return deleteArtifact(id);
}