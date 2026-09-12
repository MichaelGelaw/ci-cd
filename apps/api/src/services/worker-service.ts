import { randomUUID } from 'node:crypto';
import type { WorkerRecord, WorkerStatus, RegisterWorkerRequest } from '@mini-ci/types';
import {
  registerWorker,
  getWorker,
  listWorkers,
  touchWorkerHeartbeat,
} from '@mini-ci/db';

export async function registerWorkerService(params: RegisterWorkerRequest): Promise<WorkerRecord> {
  const id =
    params.id && params.id.trim().length > 0
      ? params.id.trim()
      : `worker-${randomUUID().slice(0, 8)}`;

  return registerWorker({
    id,
    name: params.name,
    address: params.address,
    tags: params.tags,
    metadata: params.metadata,
  });
}

export async function getWorkerService(id: string): Promise<WorkerRecord | null> {
  return getWorker(id);
}

export async function listWorkersService(filter?: {
  status?: WorkerStatus;
  limit?: number;
  offset?: number;
}): Promise<WorkerRecord[]> {
  return listWorkers(filter);
}

export async function touchWorkerHeartbeatService(
  id: string,
  status?: WorkerStatus,
): Promise<WorkerRecord> {
  return touchWorkerHeartbeat(id, status);
}
