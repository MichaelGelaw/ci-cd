import type { JobRecord, WorkerRecord } from '@mini-ci/types';

export function canWorkerRunJob(worker: WorkerRecord, job: JobRecord): boolean {
  if (worker.status !== 'ready') {
    return false;
  }

  // If the job requires a Docker container, the worker must advertise docker capability
  if (job.image && job.image.trim().length > 0) {
    const hasDockerTag = worker.tags.some((tag) => tag.toLowerCase() === 'docker');
    if (!hasDockerTag) {
      return false;
    }
  }

  return true;
}

export function selectBestWorker(
  job: JobRecord,
  availableWorkers: WorkerRecord[],
): WorkerRecord | null {
  const eligible = availableWorkers.filter((worker) => canWorkerRunJob(worker, job));

  if (eligible.length === 0) {
    return null;
  }

  // Sort eligible workers by last_heartbeat_at ascending (longest idle worker first)
  eligible.sort((a, b) => {
    const timeA = new Date(a.last_heartbeat_at).getTime();
    const timeB = new Date(b.last_heartbeat_at).getTime();
    return timeA - timeB;
  });

  return eligible[0] ?? null;
}
