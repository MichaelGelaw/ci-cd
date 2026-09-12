import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { JobQueueMessage, JobRecord } from '@mini-ci/types';
import {
  enqueueJob,
  dequeueJob,
  acknowledgeJob,
  getQueueLength,
  getProcessingLength,
  clearQueue,
  reconcileQueue,
  closeRedis,
  enqueueJobForWorker,
  dequeueJobForWorker,
  acknowledgeWorkerJob,
  getWorkerQueueLength,
  clearWorkerQueue,
} from '../src/index.js';

describe('Redis Job Queue', () => {
  beforeEach(async () => {
    await clearQueue();
  });

  afterAll(async () => {
    await clearQueue();
    await closeRedis();
  });

  it('enqueues and dequeues a job message in FIFO order', async () => {
    const msg1: JobQueueMessage = {
      jobId: 'job-1',
      workflowRunId: 'run-1',
      queuedAt: new Date().toISOString(),
      attempt: 1,
    };
    const msg2: JobQueueMessage = {
      jobId: 'job-2',
      workflowRunId: 'run-1',
      queuedAt: new Date().toISOString(),
      attempt: 1,
    };

    await enqueueJob(msg1);
    await enqueueJob(msg2);

    expect(await getQueueLength()).toBe(2);
    expect(await getProcessingLength()).toBe(0);

    const firstOut = await dequeueJob(0);
    expect(firstOut).not.toBeNull();
    expect(firstOut?.jobId).toBe('job-1');

    expect(await getQueueLength()).toBe(1);
    expect(await getProcessingLength()).toBe(1);

    const secondOut = await dequeueJob(0);
    expect(secondOut).not.toBeNull();
    expect(secondOut?.jobId).toBe('job-2');

    expect(await getQueueLength()).toBe(0);
    expect(await getProcessingLength()).toBe(2);
  });

  it('acknowledges a processing job removing it from processing queue', async () => {
    const msg: JobQueueMessage = {
      jobId: 'ack-job',
      workflowRunId: 'run-1',
      queuedAt: new Date().toISOString(),
      attempt: 1,
    };

    await enqueueJob(msg);
    const dequeued = await dequeueJob(0);
    expect(dequeued?.jobId).toBe('ack-job');

    expect(await getProcessingLength()).toBe(1);

    const acknowledged = await acknowledgeJob('ack-job');
    expect(acknowledged).toBe(true);
    expect(await getProcessingLength()).toBe(0);

    const nonExistent = await acknowledgeJob('does-not-exist');
    expect(nonExistent).toBe(false);
  });

  it('returns null on dequeue when queue is empty', async () => {
    const res = await dequeueJob(0);
    expect(res).toBeNull();
  });

  it('blocking dequeue times out when queue remains empty', async () => {
    const start = Date.now();
    const res = await dequeueJob(1); // 1 second timeout
    const elapsed = Date.now() - start;

    expect(res).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(950);
  });

  it('reconciles and recovers lost queue messages without duplication', async () => {
    const sampleJobs: JobRecord[] = [
      {
        id: 'job-lost-1',
        workflow_run_id: 'run-1',
        name: 'step-1',
        command: 'echo 1',
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
        lease_token: null,
        lease_expires_at: null,
        lease_duration_seconds: null,
        retry_policy: undefined,
        next_retry_at: null,
        created_at: new Date().toISOString(),
      },
      {
        id: 'job-lost-2',
        workflow_run_id: 'run-1',
        name: 'step-2',
        command: 'echo 2',
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
        lease_token: null,
        lease_expires_at: null,
        lease_duration_seconds: null,
        retry_policy: undefined,
        next_retry_at: null,
        created_at: new Date().toISOString(),
      },
    ];

    // Queue is currently empty (simulating Redis restart or packet loss)
    expect(await getQueueLength()).toBe(0);

    const recovered = await reconcileQueue(sampleJobs);
    expect(recovered).toBe(2);
    expect(await getQueueLength()).toBe(2);

    // Running reconcile again should not duplicate
    const secondPass = await reconcileQueue(sampleJobs);
    expect(secondPass).toBe(0);
    expect(await getQueueLength()).toBe(2);

    // Dequeue one to processing
    await dequeueJob(0);
    expect(await getQueueLength()).toBe(1);
    expect(await getProcessingLength()).toBe(1);

    // Reconcile should recognize that job-lost-1 is in processing, so it still doesn't re-enqueue
    const thirdPass = await reconcileQueue(sampleJobs);
    expect(thirdPass).toBe(0);
  });

  it('handles worker-specific job queues with reliable dequeue and acknowledge', async () => {
    const workerId = 'worker-q-test-1';
    await clearWorkerQueue(workerId);

    const msg: JobQueueMessage = {
      jobId: 'targeted-job-1',
      workflowRunId: 'run-targeted',
      queuedAt: new Date().toISOString(),
      attempt: 1,
    };

    await enqueueJobForWorker(workerId, msg);
    expect(await getWorkerQueueLength(workerId)).toBe(1);

    const dequeued = await dequeueJobForWorker(workerId, 0);
    expect(dequeued).not.toBeNull();
    expect(dequeued?.jobId).toBe('targeted-job-1');
    expect(await getWorkerQueueLength(workerId)).toBe(0);

    const acknowledged = await acknowledgeWorkerJob(workerId, 'targeted-job-1');
    expect(acknowledged).toBe(true);

    await clearWorkerQueue(workerId);
  });
});
