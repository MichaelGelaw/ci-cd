import { describe, it, expect } from 'vitest';
import type { JobRecord, WorkerRecord } from '@mini-ci/types';
import { canWorkerRunJob, selectBestWorker } from '../src/matcher.js';

describe('Scheduler Matcher', () => {
  const baseJob: JobRecord = {
    id: 'job-1',
    workflow_run_id: 'run-1',
    name: 'test-job',
    command: 'echo "hello"',
    image: null,
    status: 'queued',
    priority: 0,
    attempt: 1,
    max_attempts: 1,
    worker_id: null,
    exit_code: null,
    stdout: '',
    stderr: '',
    error: null,
    timeout_seconds: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    created_at: new Date().toISOString(),
  };

  const baseWorker: WorkerRecord = {
    id: 'worker-1',
    name: 'shell-worker',
    status: 'ready',
    address: null,
    tags: ['shell', 'linux'],
    metadata: {},
    registered_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  it('matches shell job to ready worker without docker', () => {
    expect(canWorkerRunJob(baseWorker, baseJob)).toBe(true);
  });

  it('rejects workers not in ready status', () => {
    const busyWorker: WorkerRecord = { ...baseWorker, status: 'busy' };
    expect(canWorkerRunJob(busyWorker, baseJob)).toBe(false);

    const offlineWorker: WorkerRecord = { ...baseWorker, status: 'offline' };
    expect(canWorkerRunJob(offlineWorker, baseJob)).toBe(false);
  });

  it('requires docker tag when job specifies an image', () => {
    const dockerJob: JobRecord = { ...baseJob, image: 'node:20-alpine' };

    // Worker without docker tag is rejected
    expect(canWorkerRunJob(baseWorker, dockerJob)).toBe(false);

    // Worker with docker tag is accepted
    const dockerWorker: WorkerRecord = {
      ...baseWorker,
      id: 'worker-docker',
      tags: ['docker', 'linux'],
    };
    expect(canWorkerRunJob(dockerWorker, dockerJob)).toBe(true);
  });

  it('selects the longest-idle worker among candidates', () => {
    const olderHeartbeat = new Date(Date.now() - 60000).toISOString();
    const newerHeartbeat = new Date(Date.now() - 10000).toISOString();

    const workerA: WorkerRecord = {
      ...baseWorker,
      id: 'worker-a',
      last_heartbeat_at: newerHeartbeat,
    };
    const workerB: WorkerRecord = {
      ...baseWorker,
      id: 'worker-b',
      last_heartbeat_at: olderHeartbeat,
    };

    const selected = selectBestWorker(baseJob, [workerA, workerB]);
    expect(selected?.id).toBe('worker-b');
  });

  it('returns null if no workers match requirements', () => {
    const dockerJob: JobRecord = { ...baseJob, image: 'alpine:latest' };
    const selected = selectBestWorker(dockerJob, [baseWorker]);
    expect(selected).toBeNull();
  });
});
