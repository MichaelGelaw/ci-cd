import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assignJobToWorker, closePool, createJob, createWorkflowRun, getJob,
  getJobAttempts, getPool, runMigrations, updateJobStatus,
  registerWorker, requeueJobForRetry, recoverJob,
} from '@mini-ci/db';
import { closeRedis } from '@mini-ci/queue';
import { submitWorkflow } from '../src/services/workflow-service.js';
import { updateJobExecutionStatus } from '../src/services/job-service.js';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closePool(); await closeRedis(); });

describe('workflow submission integrity', () => {
  it('validates JSON definitions before writing any state', async () => {
    await expect(submitWorkflow({ name: 'invalid-json', jobs: { build: { run: 'true', needs: ['missing'] } } }))
      .rejects.toThrow('unknown job');
  });

  it('rolls back the whole workflow when a later job fails to persist', async () => {
    const name = `rollback-${randomUUID()}`;
    await expect(submitWorkflow({ name, steps: [{ run: 'true' }, { name: 'x'.repeat(256), run: 'true' }] }))
      .rejects.toThrow();
    const { rows } = await getPool().query('SELECT id FROM workflow_runs WHERE workflow_name = $1', [name]);
    expect(rows).toHaveLength(0);
  });

  it('stages sequential steps and cancels them after an upstream failure', async () => {
    const { jobs } = await submitWorkflow({ name: 'sequential', steps: [{ run: 'false' }, { run: 'true' }] });
    expect(jobs.map((job) => job.status)).toEqual(['queued', 'created']);
    await updateJobStatus(jobs[0]!.id, 'assigned');
    await updateJobStatus(jobs[0]!.id, 'running');
    await updateJobExecutionStatus(jobs[0]!.id, { status: 'failed', exitCode: 1 });
    expect((await getJob(jobs[1]!.id))?.status).toBe('cancelled');
  });

  it('does not mask an early command failure with a later successful step', async () => {
    const { jobs } = await submitWorkflow({
      name: 'fail-fast',
      jobs: { build: { steps: [{ run: 'exit 7' }, { run: 'echo unexpected' }] } },
    });
    const result = spawnSync('sh', ['-c', jobs[0]!.command], { encoding: 'utf8' });
    expect(result.status).toBe(7);
    expect(result.stdout).not.toContain('unexpected');
  });

  it('preserves normal shell exit semantics within an individual step', async () => {
    const { jobs } = await submitWorkflow({
      name: 'shell-semantics',
      jobs: { build: { steps: [{ run: "false; printf '%s' recovered" }] } },
    });
    const result = spawnSync('sh', ['-c', jobs[0]!.command], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('recovered');
  });
});

describe('worker report fencing', () => {
  it('allows only one concurrent reservation for a worker', async () => {
    const run = await createWorkflowRun('atomic-worker');
    const worker = await registerWorker({ id: randomUUID(), name: 'atomic-worker' });
    const jobs = await Promise.all([1, 2].map((index) => createJob({
      workflowRunId: run.id, name: `job-${index}`, command: 'true', status: 'queued',
    })));
    const results = await Promise.allSettled(jobs.map((job) => assignJobToWorker(job.id, worker.id)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('enforces workflow concurrency across concurrent schedulers', async () => {
    const run = await createWorkflowRun('atomic-workflow');
    const workers = await Promise.all([1, 2].map((index) => registerWorker({
      id: randomUUID(), name: `worker-${index}`,
    })));
    const jobs = await Promise.all([1, 2].map((index) => createJob({
      workflowRunId: run.id, name: `job-${index}`, command: 'true', status: 'queued',
    })));
    const results = await Promise.allSettled(jobs.map((job, index) =>
      assignJobToWorker(job.id, workers[index]!.id, 30, 1),
    ));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('does not increment the retry attempt twice when dispatchers race', async () => {
    const run = await createWorkflowRun('atomic-retry');
    const job = await createJob({ workflowRunId: run.id, name: 'retry', command: 'true', status: 'retrying' });
    const results = await Promise.allSettled([requeueJobForRetry(job.id), requeueJobForRetry(job.id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await getJob(job.id))?.attempt).toBe(2);
  });

  it('rechecks staleness before recovering a job whose lease is current', async () => {
    const run = await createWorkflowRun('renewed-lease');
    const worker = await registerWorker({ id: randomUUID(), name: 'live-worker' });
    const job = await createJob({ workflowRunId: run.id, name: 'live', command: 'true', status: 'queued' });
    await assignJobToWorker(job.id, worker.id);
    const result = await recoverJob(job.id, 'Stale snapshot', { onlyIfStale: {} });
    expect(result.action).toBe('ignored');
    expect((await getJob(job.id))?.status).toBe('assigned');
    expect(await getJobAttempts(job.id)).toHaveLength(0);
  });

  it('rejects a stale worker report without changing state or attempt history', async () => {
    const run = await createWorkflowRun('fencing');
    const job = await createJob({ workflowRunId: run.id, name: 'build', command: 'true', status: 'queued' });
    const assigned = await assignJobToWorker(job.id, 'owner');
    await updateJobStatus(job.id, 'running');
    await expect(updateJobExecutionStatus(job.id, { status: 'succeeded', workerId: 'stale', leaseToken: 'old' }))
      .rejects.toThrow('lease ownership');
    await expect(updateJobExecutionStatus(job.id, { status: 'succeeded', workerId: 'owner' }))
      .rejects.toThrow('lease ownership');
    expect((await getJob(job.id))?.status).toBe('running');
    expect(await getJobAttempts(job.id)).toHaveLength(0);
    const completed = await updateJobExecutionStatus(job.id, {
      status: 'succeeded', workerId: 'owner', leaseToken: assigned.lease_token!,
    });
    expect(completed.status).toBe('succeeded');
  });

  it('atomically records retryable failures without exposing terminal state to dependents', async () => {
    const { jobs } = await submitWorkflow({
      name: 'retry-dag', jobs: { build: { run: 'false', retries: 1 }, deploy: { run: 'true', needs: ['build'] } },
    });
    const root = jobs[0]!;
    await updateJobStatus(root.id, 'assigned');
    await updateJobStatus(root.id, 'running');
    const result = await updateJobExecutionStatus(root.id, { status: 'failed', exitCode: 1 });
    expect(result.status).toBe('retrying');
    expect((await getJob(jobs[1]!.id))?.status).toBe('created');
    expect((await getJobAttempts(root.id))[0]?.status).toBe('failed');
  });
});
