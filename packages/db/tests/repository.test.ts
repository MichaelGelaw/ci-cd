import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  runMigrations,
  closePool,
  createWorkflowRun,
  updateWorkflowRun,
  getWorkflowRun,
  createJob,
  getJob,
  getJobsByWorkflowRun,
  updateJobStatus,
  recordJobAttempt,
  getJobAttempts,
  registerWorker,
  getWorker,
  listWorkers,
  updateWorkerStatus,
  touchWorkerHeartbeat,
} from '../src/index.js';

describe('Database Repository', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it('applies migrations idempotently', async () => {
    const newlyApplied = await runMigrations();
    expect(newlyApplied).toEqual([]);
  });

  it('creates and retrieves workflow runs', async () => {
    const run = await createWorkflowRun('test-workflow', 'running');
    expect(run.id).toBeTruthy();
    expect(run.workflow_name).toBe('test-workflow');
    expect(run.status).toBe('running');

    const fetched = await getWorkflowRun(run.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(run.id);

    const updated = await updateWorkflowRun(run.id, {
      status: 'succeeded',
      duration_ms: 1500,
    });
    expect(updated.status).toBe('succeeded');
    expect(updated.duration_ms).toBe(1500);
  });

  it('manages jobs and enforces legal state transitions', async () => {
    const run = await createWorkflowRun('job-lifecycle-run', 'running');

    const job = await createJob({
      workflowRunId: run.id,
      name: 'build-step',
      command: 'echo "building"',
      image: 'alpine:latest',
      timeoutSeconds: 30,
    });

    expect(job.status).toBe('created');
    expect(job.name).toBe('build-step');

    // Legal transitions: created -> queued -> assigned -> running -> succeeded
    const queuedJob = await updateJobStatus(job.id, 'queued');
    expect(queuedJob.status).toBe('queued');

    const assignedJob = await updateJobStatus(job.id, 'assigned', {
      workerId: 'worker-1',
    });
    expect(assignedJob.status).toBe('assigned');
    expect(assignedJob.worker_id).toBe('worker-1');

    const runningJob = await updateJobStatus(job.id, 'running', {
      startedAt: new Date(),
    });
    expect(runningJob.status).toBe('running');

    const succeededJob = await updateJobStatus(job.id, 'succeeded', {
      exitCode: 0,
      stdout: 'build complete',
      durationMs: 450,
      finishedAt: new Date(),
    });
    expect(succeededJob.status).toBe('succeeded');
    expect(succeededJob.exit_code).toBe(0);
    expect(succeededJob.stdout).toBe('build complete');

    // Illegal transition: succeeded -> running must fail
    await expect(updateJobStatus(job.id, 'running')).rejects.toThrow(
      'Invalid job state transition',
    );

    const jobs = await getJobsByWorkflowRun(run.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('succeeded');
  });

  it('records and retrieves job execution attempts', async () => {
    const run = await createWorkflowRun('attempt-test-run', 'running');
    const job = await createJob({
      workflowRunId: run.id,
      name: 'flaky-step',
      command: 'exit 1',
      maxAttempts: 3,
    });

    const attempt1 = await recordJobAttempt({
      jobId: job.id,
      attemptNumber: 1,
      status: 'failed',
      exitCode: 1,
      stderr: 'unexpected error',
      durationMs: 200,
    });

    expect(attempt1.id).toBeTruthy();
    expect(attempt1.attempt_number).toBe(1);
    expect(attempt1.status).toBe('failed');

    const attempt2 = await recordJobAttempt({
      jobId: job.id,
      attemptNumber: 2,
      status: 'succeeded',
      exitCode: 0,
      stdout: 'recovered',
      durationMs: 150,
    });

    expect(attempt2.attempt_number).toBe(2);
    expect(attempt2.status).toBe('succeeded');

    const attempts = await getJobAttempts(job.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.status).toBe('failed');
    expect(attempts[1]?.status).toBe('succeeded');
  });

  it('registers, retrieves, lists, and updates workers', async () => {
    const workerId = `worker-test-${Date.now()}`;

    // Register worker
    const worker = await registerWorker({
      id: workerId,
      name: 'worker-node-1',
      address: '10.0.0.1:5000',
      tags: ['docker', 'linux', 'python'],
      metadata: { os: 'linux', arch: 'x86_64', cpus: 4 },
    });

    expect(worker.id).toBe(workerId);
    expect(worker.name).toBe('worker-node-1');
    expect(worker.status).toBe('ready');
    expect(worker.address).toBe('10.0.0.1:5000');
    expect(worker.tags).toEqual(['docker', 'linux', 'python']);
    expect(worker.metadata).toEqual({ os: 'linux', arch: 'x86_64', cpus: 4 });

    // Retrieve worker by ID
    const fetched = await getWorker(workerId);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(workerId);
    expect(fetched?.status).toBe('ready');

    // List workers with filter
    const readyWorkers = await listWorkers({ status: 'ready' });
    expect(readyWorkers.some((w) => w.id === workerId)).toBe(true);

    // Update worker status to busy
    const busyWorker = await updateWorkerStatus(workerId, 'busy');
    expect(busyWorker.status).toBe('busy');

    // Touch heartbeat
    const touchedWorker = await touchWorkerHeartbeat(workerId, 'ready');
    expect(touchedWorker.status).toBe('ready');
    expect(new Date(touchedWorker.last_heartbeat_at).getTime()).toBeGreaterThanOrEqual(
      new Date(worker.last_heartbeat_at).getTime(),
    );

    // Re-registration is idempotent and updates fields
    const updatedWorker = await registerWorker({
      id: workerId,
      name: 'worker-node-1-renamed',
      address: '10.0.0.2:5000',
      tags: ['docker', 'arm64'],
      metadata: { os: 'linux', arch: 'arm64' },
    });
    expect(updatedWorker.id).toBe(workerId);
    expect(updatedWorker.name).toBe('worker-node-1-renamed');
    expect(updatedWorker.address).toBe('10.0.0.2:5000');
    expect(updatedWorker.tags).toEqual(['docker', 'arm64']);
    expect(updatedWorker.status).toBe('ready');
  });
});
