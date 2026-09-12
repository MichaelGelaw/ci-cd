import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  runMigrations,
  closePool,
  getPool,
  createWorkflowRun,
  createJob,
  registerWorker,
  getJob,
  getWorker,
} from '@mini-ci/db';
import {
  closeRedis,
  clearQueue,
  clearWorkerQueue,
  getWorkerQueueLength,
  dequeueJobForWorker,
} from '@mini-ci/queue';
import { Scheduler } from '../src/index.js';

describe('Scheduler Job-to-Worker Assignment', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
    await closeRedis();
  });

  beforeEach(async () => {
    const pool = getPool();
    await pool.query("UPDATE workers SET status = 'offline' WHERE status = 'ready';");
    await pool.query("UPDATE jobs SET status = 'cancelled' WHERE status = 'queued';");
    await clearQueue();
  });

  it('assigns high priority queued jobs before low priority jobs', async () => {
    const run = await createWorkflowRun('priority-test-run', 'running');

    // Create low priority job
    const lowPriorityJob = await createJob({
      workflowRunId: run.id,
      name: 'low-priority',
      command: 'echo "low"',
      priority: 0,
      status: 'queued',
    });

    // Create high priority job
    const highPriorityJob = await createJob({
      workflowRunId: run.id,
      name: 'high-priority',
      command: 'echo "high"',
      priority: 10,
      status: 'queued',
    });

    // Register a single ready worker
    const workerId = `worker-prio-${Date.now()}`;
    await registerWorker({
      id: workerId,
      name: 'worker-prio',
      tags: ['shell'],
    });

    // Run scheduler round
    const scheduler = new Scheduler();
    const decisions = await scheduler.scheduleRound();

    expect(decisions.length).toBeGreaterThanOrEqual(1);

    // The high priority job MUST be scheduled first
    const scheduledHigh = decisions.find((d) => d.jobId === highPriorityJob.id);
    expect(scheduledHigh).toBeDefined();
    expect(scheduledHigh?.workerId).toBe(workerId);

    // DB verification: high priority job is assigned, low priority job is still queued
    const fetchedHigh = await getJob(highPriorityJob.id);
    expect(fetchedHigh?.status).toBe('assigned');
    expect(fetchedHigh?.worker_id).toBe(workerId);

    const fetchedLow = await getJob(lowPriorityJob.id);
    expect(fetchedLow?.status).toBe('queued');

    // Worker status is marked busy
    const fetchedWorker = await getWorker(workerId);
    expect(fetchedWorker?.status).toBe('busy');

    // Redis verification: job message was pushed to worker's queue
    expect(await getWorkerQueueLength(workerId)).toBe(1);
    const msg = await dequeueJobForWorker(workerId, 0);
    expect(msg?.jobId).toBe(highPriorityJob.id);

    await clearWorkerQueue(workerId);
  });

  it('enforces capability matching for Docker container images', async () => {
    const run = await createWorkflowRun('docker-capability-run', 'running');

    // Docker job
    const dockerJob = await createJob({
      workflowRunId: run.id,
      name: 'docker-job',
      command: 'echo "docker"',
      image: 'python:3.14-alpine',
      status: 'queued',
    });

    // Shell worker (no docker)
    const shellWorkerId = `shell-worker-${Date.now()}`;
    await registerWorker({
      id: shellWorkerId,
      name: 'shell-worker',
      tags: ['shell'],
    });

    // Docker worker
    const dockerWorkerId = `docker-worker-${Date.now()}`;
    await registerWorker({
      id: dockerWorkerId,
      name: 'docker-worker',
      tags: ['docker', 'shell'],
    });

    const scheduler = new Scheduler();
    const decisions = await scheduler.scheduleRound();

    // Docker job must be scheduled to the Docker worker, never the shell worker
    const decision = decisions.find((d) => d.jobId === dockerJob.id);
    expect(decision).toBeDefined();
    expect(decision?.workerId).toBe(dockerWorkerId);

    const fetched = await getJob(dockerJob.id);
    expect(fetched?.worker_id).toBe(dockerWorkerId);

    await clearWorkerQueue(dockerWorkerId);
    await clearWorkerQueue(shellWorkerId);
  });

  it('enforces workflow concurrency limits', async () => {
    const run = await createWorkflowRun('concurrency-test-run', 'running');

    // Create 3 queued jobs for the same workflow run
    const job1 = await createJob({
      workflowRunId: run.id,
      name: 'concurrent-1',
      command: 'echo 1',
      status: 'queued',
    });
    const job2 = await createJob({
      workflowRunId: run.id,
      name: 'concurrent-2',
      command: 'echo 2',
      status: 'queued',
    });
    const job3 = await createJob({
      workflowRunId: run.id,
      name: 'concurrent-3',
      command: 'echo 3',
      status: 'queued',
    });

    // Register 3 ready workers
    const w1 = `w-conc-1-${Date.now()}`;
    const w2 = `w-conc-2-${Date.now()}`;
    const w3 = `w-conc-3-${Date.now()}`;

    await registerWorker({ id: w1, name: 'w1', tags: ['shell'] });
    await registerWorker({ id: w2, name: 'w2', tags: ['shell'] });
    await registerWorker({ id: w3, name: 'w3', tags: ['shell'] });

    // Restrict max concurrency per workflow to 1
    const scheduler = new Scheduler({ maxConcurrencyPerWorkflow: 1 });
    const decisions = await scheduler.scheduleRound();

    // Only 1 job from this workflow run should be scheduled in this round
    const workflowDecisions = decisions.filter((d) => d.workflowRunId === run.id);
    expect(workflowDecisions.length).toBe(1);

    await clearWorkerQueue(w1);
    await clearWorkerQueue(w2);
    await clearWorkerQueue(w3);
  });

  it('handles empty queue or no available workers gracefully', async () => {
    const scheduler = new Scheduler();
    const decisions = await scheduler.scheduleRound();
    expect(Array.isArray(decisions)).toBe(true);
  });

  it('promotes created DAG jobs whose dependencies succeeded and assigns them to workers', async () => {
    const run = await createWorkflowRun('dag-scheduler-test', 'running');

    // Job A is already succeeded
    const jobA = await createJob({
      workflowRunId: run.id,
      jobKey: 'job-a',
      needs: [],
      name: 'Job A',
      command: 'echo a',
      status: 'succeeded',
    });

    // Job B is created and depends on Job A
    const jobB = await createJob({
      workflowRunId: run.id,
      jobKey: 'job-b',
      needs: ['job-a'],
      name: 'Job B',
      command: 'echo b',
      status: 'created',
    });

    // Register a ready worker
    const workerId = `worker-dag-${Date.now()}`;
    await registerWorker({
      id: workerId,
      name: 'worker-dag',
      tags: ['shell'],
    });

    const scheduler = new Scheduler();
    const decisions = await scheduler.scheduleRound();

    // Job B should be promoted and assigned to worker
    const decision = decisions.find((d) => d.jobId === jobB.id);
    expect(decision).toBeDefined();
    expect(decision?.workerId).toBe(workerId);

    const fetchedJobB = await getJob(jobB.id);
    expect(fetchedJobB?.status).toBe('assigned');
    expect(fetchedJobB?.worker_id).toBe(workerId);

    await clearWorkerQueue(workerId);
  });
});
