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
  reapDeadWorkers,
  findStaleWorkers,
  assignJobToWorker,
  renewJobLease,
  releaseJobLease,
  findExpiredLeases,
  LeaseConflictError,
  findDueRetryingJobs,
  requeueJobForRetry,
  calculateRetryDelay,
  isFailureRetryable,
  findRecoverableJobs,
  recoverJob,
  recoverStaleJobs,
  cancelWorkflowRun,
  createArtifact,
  getArtifact,
  getArtifactsByJob,
  getArtifactsByWorkflowRun,
  deleteArtifact,
  findStagedJobs,
  evaluateAndPromoteDependentJobs,
  getPool,
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

  it('detects and reaps stale workers whose heartbeats expired', async () => {
    const staleWorkerId = `stale-worker-${Date.now()}`;
    const activeWorkerId = `active-worker-${Date.now()}`;

    // Register active worker
    await registerWorker({
      id: activeWorkerId,
      name: 'active-worker',
      tags: ['docker'],
    });

    // Register worker and manually backdate last_heartbeat_at
    await registerWorker({
      id: staleWorkerId,
      name: 'stale-worker',
      tags: ['shell'],
    });

    const pool = getPool();
    await pool.query(
      "UPDATE workers SET last_heartbeat_at = NOW() - INTERVAL '120 seconds' WHERE id = $1;",
      [staleWorkerId],
    );

    // Find stale workers with 30s threshold
    const staleList = await findStaleWorkers(30);
    expect(staleList.some((w) => w.id === staleWorkerId)).toBe(true);
    expect(staleList.some((w) => w.id === activeWorkerId)).toBe(false);

    // Reap dead workers with 30s threshold
    const reaped = await reapDeadWorkers(30);
    expect(reaped.some((w) => w.id === staleWorkerId)).toBe(true);
    expect(reaped.some((w) => w.id === activeWorkerId)).toBe(false);

    // Verify DB state
    const staleRecord = await getWorker(staleWorkerId);
    expect(staleRecord?.status).toBe('offline');

    const activeRecord = await getWorker(activeWorkerId);
    expect(activeRecord?.status).toBe('ready');
  });

  it('assigns job with lease and renews valid lease', async () => {
    const run = await createWorkflowRun('lease-test-workflow', 'running');
    const job = await createJob({
      workflowRunId: run.id,
      name: 'lease-job-1',
      command: 'echo "test"',
    });
    await updateJobStatus(job.id, 'queued');

    // Assign job to worker
    const assigned = await assignJobToWorker(job.id, 'worker-alpha', 30);
    expect(assigned.status).toBe('assigned');
    expect(assigned.worker_id).toBe('worker-alpha');
    expect(assigned.lease_token).toBeTruthy();
    expect(assigned.lease_expires_at).toBeTruthy();
    expect(assigned.lease_duration_seconds).toBe(30);

    const originalExpiresAt = new Date(assigned.lease_expires_at!).getTime();

    // Transition to running preserves lease
    const running = await updateJobStatus(job.id, 'running');
    expect(running.lease_token).toBe(assigned.lease_token);

    // Renew lease with valid token
    const renewal = await renewJobLease(job.id, assigned.lease_token!, 60);
    expect(renewal.job.lease_duration_seconds).toBe(60);
    const renewedExpiresAt = new Date(renewal.leaseExpiresAt).getTime();
    expect(renewedExpiresAt).toBeGreaterThan(originalExpiresAt);

    // Renew with invalid token fails with LeaseConflictError
    await expect(renewJobLease(job.id, 'invalid-token-12345', 30)).rejects.toThrow(
      LeaseConflictError,
    );

    // Transition to succeeded automatically clears lease
    const succeeded = await updateJobStatus(job.id, 'succeeded');
    expect(succeeded.lease_token).toBeNull();
    expect(succeeded.lease_expires_at).toBeNull();
  });

  it('detects expired leases and blocks renewal of expired lease', async () => {
    const run = await createWorkflowRun('expired-lease-workflow', 'running');
    const job = await createJob({
      workflowRunId: run.id,
      name: 'lease-job-expired',
      command: 'echo "expired"',
    });
    await updateJobStatus(job.id, 'queued');

    const assigned = await assignJobToWorker(job.id, 'worker-beta', 30);
    const pool = getPool();

    // Backdate lease_expires_at to the past
    await pool.query(
      "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '60 seconds' WHERE id = $1;",
      [job.id],
    );

    // findExpiredLeases should find this job
    const expiredList = await findExpiredLeases(0);
    expect(expiredList.some((j) => j.id === job.id)).toBe(true);

    // Renewing expired lease must fail with LeaseConflictError
    await expect(renewJobLease(job.id, assigned.lease_token!, 30)).rejects.toThrow(
      LeaseConflictError,
    );

    // Releasing the lease clears it
    const released = await releaseJobLease(job.id, assigned.lease_token!);
    expect(released.lease_token).toBeNull();
    expect(released.lease_expires_at).toBeNull();
  });

  it('calculates exponential backoff delay and evaluates retry eligibility', () => {
    // Attempt 1: base delay * 2^0 = 2s (without jitter)
    const delay1 = calculateRetryDelay(1, {
      base_delay_seconds: 2,
      backoff_factor: 2,
      jitter: false,
    });
    expect(delay1).toBe(2);

    // Attempt 2: base delay * 2^1 = 4s
    const delay2 = calculateRetryDelay(2, {
      base_delay_seconds: 2,
      backoff_factor: 2,
      jitter: false,
    });
    expect(delay2).toBe(4);

    // Attempt 3: base delay * 2^2 = 8s
    const delay3 = calculateRetryDelay(3, {
      base_delay_seconds: 2,
      backoff_factor: 2,
      jitter: false,
    });
    expect(delay3).toBe(8);

    // Capped at max_delay_seconds
    const cappedDelay = calculateRetryDelay(10, {
      base_delay_seconds: 2,
      max_delay_seconds: 15,
      jitter: false,
    });
    expect(cappedDelay).toBe(15);

    // With jitter enabled, delay is >= base delay
    const delayWithJitter = calculateRetryDelay(2, {
      base_delay_seconds: 2,
      jitter: true,
    });
    expect(delayWithJitter).toBeGreaterThanOrEqual(4);

    // Failure retryability
    expect(isFailureRetryable('failed')).toBe(true);
    expect(isFailureRetryable('timed_out', { retry_on_timeout: true })).toBe(true);
    expect(isFailureRetryable('timed_out', { retry_on_timeout: false })).toBe(false);
    expect(isFailureRetryable('cancelled')).toBe(false);
    expect(isFailureRetryable('succeeded')).toBe(false);
  });

  it('persists retry policy and manages retrying lifecycle with atomic requeue', async () => {
    const run = await createWorkflowRun('retry-lifecycle-workflow', 'running');

    const job = await createJob({
      workflowRunId: run.id,
      name: 'flaky-step',
      command: 'exit 1',
      retryPolicy: {
        max_attempts: 3,
        base_delay_seconds: 5,
        backoff_factor: 2,
        jitter: false,
      },
    });

    expect(job.max_attempts).toBe(3);
    expect(job.attempt).toBe(1);
    expect(job.status).toBe('created');
    expect(job.retry_policy).toEqual({
      max_attempts: 3,
      base_delay_seconds: 5,
      backoff_factor: 2,
      jitter: false,
    });

    // Move to queued -> assigned -> running
    await updateJobStatus(job.id, 'queued');
    await assignJobToWorker(job.id, 'worker-retry-test', 30);
    await updateJobStatus(job.id, 'running');

    // Simulate failure: transitions running -> failed -> retrying
    await updateJobStatus(job.id, 'failed', { exitCode: 1 });

    const nextRetry = new Date(Date.now() - 5000); // 5 seconds in the past so it's due
    const retryingJob = await updateJobStatus(job.id, 'retrying', {
      nextRetryAt: nextRetry,
    });
    expect(retryingJob.status).toBe('retrying');
    expect(retryingJob.lease_token).toBeNull();
    expect(retryingJob.next_retry_at).toBeTruthy();

    // Query due retries
    const dueJobs = await findDueRetryingJobs();
    expect(dueJobs.some((j) => j.id === job.id)).toBe(true);

    // Atomically requeue for retry
    const requeuedJob = await requeueJobForRetry(job.id);
    expect(requeuedJob.status).toBe('queued');
    expect(requeuedJob.attempt).toBe(2);
    expect(requeuedJob.max_attempts).toBe(3);
    expect(requeuedJob.worker_id).toBeNull();
    expect(requeuedJob.next_retry_at).toBeNull();
    expect(requeuedJob.exit_code).toBeNull();
  });

  it('detects and recovers orphaned jobs with expired leases or dead workers', async () => {
    const run = await createWorkflowRun('recovery-test-workflow', 'running');
    const pool = getPool();

    // Create worker 1
    const worker1 = await registerWorker({
      id: `worker-crashed-${Date.now()}`,
      name: 'worker-crashed',
      tags: ['docker'],
    });

    // Create job 1: assigned to worker1, with expired lease, 2 attempts
    const job1 = await createJob({
      workflowRunId: run.id,
      name: 'step-expired-lease',
      command: 'echo test',
      maxAttempts: 2,
    });
    await updateJobStatus(job1.id, 'queued');
    await assignJobToWorker(job1.id, worker1.id, 30);
    await updateJobStatus(job1.id, 'running');

    // Backdate lease to expired
    await pool.query(
      "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1;",
      [job1.id],
    );

    // Create job 2: assigned to worker1, retries exhausted (maxAttempts: 1)
    const job2 = await createJob({
      workflowRunId: run.id,
      name: 'step-exhausted-retries',
      command: 'echo test-2',
      maxAttempts: 1,
    });
    await updateJobStatus(job2.id, 'queued');
    await assignJobToWorker(job2.id, worker1.id, 30);

    // Set worker1 to offline (simulating worker crash/reaping)
    await updateWorkerStatus(worker1.id, 'offline');

    // findRecoverableJobs should find both job1 and job2
    const recoverable = await findRecoverableJobs();
    expect(recoverable.some((j) => j.id === job1.id)).toBe(true);
    expect(recoverable.some((j) => j.id === job2.id)).toBe(true);

    // Recover job1: retries remain, should transition to retrying
    const recovery1 = await recoverJob(job1.id, 'Worker crashed during execution');
    expect(recovery1.action).toBe('retrying');
    expect(recovery1.job.status).toBe('retrying');
    expect(recovery1.job.lease_token).toBeNull();
    expect(recovery1.job.lease_expires_at).toBeNull();

    // Verify attempt was recorded as failed
    const attempts1 = await getJobAttempts(job1.id);
    expect(attempts1.length).toBe(1);
    expect(attempts1[0]?.status).toBe('failed');
    expect(attempts1[0]?.error).toContain('Worker crashed');

    // Recover job2: retries exhausted, should transition to terminal failed
    const recovery2 = await recoverJob(job2.id, 'Worker offline before execution');
    expect(recovery2.action).toBe('failed');
    expect(recovery2.job.status).toBe('failed');
    expect(recovery2.job.error).toContain('Worker offline');

    // Recovering a job already failed should be ignored
    const recovery2Again = await recoverJob(job2.id);
    expect(recovery2Again.action).toBe('ignored');

    // Test immediate requeue option
    const job3 = await createJob({
      workflowRunId: run.id,
      name: 'step-immediate-recovery',
      command: 'echo test-3',
      maxAttempts: 3,
    });
    await updateJobStatus(job3.id, 'queued');
    await assignJobToWorker(job3.id, worker1.id, 30);

    const recovery3 = await recoverJob(job3.id, 'Immediate recovery test', {
      immediateRequeue: true,
    });
    expect(recovery3.action).toBe('requeued');
    expect(recovery3.job.status).toBe('queued');
    expect(recovery3.job.attempt).toBe(2);
    expect(recovery3.job.worker_id).toBeNull();

    // Test batch recoverStaleJobs
    const job4 = await createJob({
      workflowRunId: run.id,
      name: 'step-batch-recover',
      command: 'echo test-4',
      maxAttempts: 2,
    });
    await updateJobStatus(job4.id, 'queued');
    await assignJobToWorker(job4.id, worker1.id, 30);

    const batchRecovered = await recoverStaleJobs();
    expect(batchRecovered.some((r) => r.job.id === job4.id)).toBe(true);
  });

  it('cancels workflow run and all active in-flight jobs atomically', async () => {
    const run = await createWorkflowRun('cancel-run-workflow', 'running');

    // 1. Succeeded job (already finished)
    const jobSuccess = await createJob({
      workflowRunId: run.id,
      name: 'step-done',
      command: 'echo 0',
    });
    await updateJobStatus(jobSuccess.id, 'queued');
    await updateJobStatus(jobSuccess.id, 'assigned');
    await updateJobStatus(jobSuccess.id, 'running');
    await updateJobStatus(jobSuccess.id, 'succeeded', { exitCode: 0 });

    // 2. Running job with lease
    const jobRunning = await createJob({
      workflowRunId: run.id,
      name: 'step-running',
      command: 'sleep 100',
    });
    await updateJobStatus(jobRunning.id, 'queued');
    const assignedRunning = await assignJobToWorker(jobRunning.id, 'worker-cancel-test', 30);
    await updateJobStatus(jobRunning.id, 'running');

    // 3. Queued job
    const jobQueued = await createJob({
      workflowRunId: run.id,
      name: 'step-queued',
      command: 'echo next',
    });
    await updateJobStatus(jobQueued.id, 'queued');

    // Cancel workflow run
    const result = await cancelWorkflowRun(run.id, 'Aborted by user via CLI');
    expect(result.run.status).toBe('cancelled');
    expect(result.run.error).toBe('Aborted by user via CLI');
    expect(result.cancelledJobs).toHaveLength(2);

    // Verify running job is cancelled and lease cleared
    const checkRunning = await getJob(jobRunning.id);
    expect(checkRunning?.status).toBe('cancelled');
    expect(checkRunning?.lease_token).toBeNull();
    expect(checkRunning?.lease_expires_at).toBeNull();
    expect(checkRunning?.error).toContain('Aborted by user via CLI');

    // Verify queued job is cancelled
    const checkQueued = await getJob(jobQueued.id);
    expect(checkQueued?.status).toBe('cancelled');

    // Verify succeeded job remained succeeded
    const checkSuccess = await getJob(jobSuccess.id);
    expect(checkSuccess?.status).toBe('succeeded');
  });

  it('manages artifact persistence and queries by job and workflow run', async () => {
    const run = await createWorkflowRun('artifact-test-workflow', 'running');
    const job = await createJob({
      workflowRunId: run.id,
      name: 'build-app',
      command: 'npm run build',
      artifacts: { name: 'dist', paths: ['dist/**'] },
    });

    // Verify job was created with configured artifacts
    expect(job.artifacts).toEqual({ name: 'dist', paths: ['dist/**'] });
    const fetchedJob = await getJob(job.id);
    expect(fetchedJob?.artifacts).toEqual({ name: 'dist', paths: ['dist/**'] });

    // 1. Create artifact
    const artifact1 = await createArtifact({
      jobId: job.id,
      workflowRunId: run.id,
      name: 'build.tar.gz',
      path: 'dist/build.tar.gz',
      sizeBytes: 10240,
      mimeType: 'application/gzip',
      storagePath: '/data/artifacts/run-1/build.tar.gz',
      checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });

    expect(artifact1.id).toBeTruthy();
    expect(artifact1.name).toBe('build.tar.gz');
    expect(artifact1.path).toBe('dist/build.tar.gz');
    expect(Number(artifact1.size_bytes)).toBe(10240);
    expect(artifact1.mime_type).toBe('application/gzip');
    expect(artifact1.storage_path).toBe('/data/artifacts/run-1/build.tar.gz');
    expect(artifact1.checksum).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

    // 2. Query artifact by id
    const fetchedArtifact = await getArtifact(artifact1.id);
    expect(fetchedArtifact).not.toBeNull();
    expect(fetchedArtifact?.name).toBe('build.tar.gz');

    // 3. Create second artifact for same job
    const artifact2 = await createArtifact({
      jobId: job.id,
      workflowRunId: run.id,
      name: 'coverage.json',
      path: 'coverage/coverage-final.json',
      sizeBytes: 2048,
      mimeType: 'application/json',
      storagePath: '/data/artifacts/run-1/coverage.json',
    });

    // 4. Query artifacts by job
    const jobArtifacts = await getArtifactsByJob(job.id);
    expect(jobArtifacts).toHaveLength(2);
    expect(jobArtifacts.map((a) => a.name)).toContain('build.tar.gz');
    expect(jobArtifacts.map((a) => a.name)).toContain('coverage.json');

    // 5. Query artifacts by workflow run
    const runArtifacts = await getArtifactsByWorkflowRun(run.id);
    expect(runArtifacts).toHaveLength(2);

    // 6. Delete artifact
    const deleted = await deleteArtifact(artifact1.id);
    expect(deleted).toBe(true);

    const checkDeleted = await getArtifact(artifact1.id);
    expect(checkDeleted).toBeNull();

    const remaining = await getArtifactsByJob(job.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.name).toBe('coverage.json');
  });

  it('persists and retrieves job_key and needs dependencies', async () => {
    const run = await createWorkflowRun('multi-job-pipeline');

    const buildJob = await createJob({
      workflowRunId: run.id,
      jobKey: 'build',
      needs: [],
      name: 'Build Artifacts',
      command: 'npm run build',
    });

    expect(buildJob.job_key).toBe('build');
    expect(buildJob.needs).toEqual([]);

    const testJob = await createJob({
      workflowRunId: run.id,
      jobKey: 'test',
      needs: ['build'],
      name: 'Unit Tests',
      command: 'npm test',
    });

    expect(testJob.job_key).toBe('test');
    expect(testJob.needs).toEqual(['build']);

    const fetchedJob = await getJob(testJob.id);
    expect(fetchedJob?.job_key).toBe('test');
    expect(fetchedJob?.needs).toEqual(['build']);

    const jobs = await getJobsByWorkflowRun(run.id);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.job_key).toBe('build');
    expect(jobs[0]?.needs).toEqual([]);
    expect(jobs[1]?.job_key).toBe('test');
    expect(jobs[1]?.needs).toEqual(['build']);
  });

  it('evaluates DAG dependencies and promotes jobs when upstream dependencies succeed', async () => {
    const run = await createWorkflowRun('dag-promotion-test');

    const build = await createJob({
      workflowRunId: run.id,
      jobKey: 'build',
      needs: [],
      name: 'Build',
      command: 'npm run build',
      status: 'created',
    });

    const lint = await createJob({
      workflowRunId: run.id,
      jobKey: 'lint',
      needs: [],
      name: 'Lint',
      command: 'npm run lint',
      status: 'created',
    });

    const test = await createJob({
      workflowRunId: run.id,
      jobKey: 'test',
      needs: ['build'],
      name: 'Test',
      command: 'npm test',
      status: 'created',
    });

    const deploy = await createJob({
      workflowRunId: run.id,
      jobKey: 'deploy',
      needs: ['test', 'lint'],
      name: 'Deploy',
      command: './deploy.sh',
      status: 'created',
    });

    // 1. Initial evaluation: root jobs (build, lint) should be promoted
    const round1 = await evaluateAndPromoteDependentJobs(run.id);
    expect(round1.promoted.map((j) => j.job_key).sort()).toEqual(['build', 'lint']);
    expect(round1.cancelled).toEqual([]);

    const stagedAfterRound1 = await findStagedJobs(run.id);
    expect(stagedAfterRound1.map((j) => j.job_key).sort()).toEqual(['deploy', 'test']);

    // 2. Mark build as succeeded; lint is still queued
    await updateJobStatus(build.id, 'assigned');
    await updateJobStatus(build.id, 'running');
    await updateJobStatus(build.id, 'succeeded');

    const round2 = await evaluateAndPromoteDependentJobs(run.id);
    expect(round2.promoted.map((j) => j.job_key)).toEqual(['test']);

    // deploy is still waiting on lint and test
    const stagedAfterRound2 = await findStagedJobs(run.id);
    expect(stagedAfterRound2.map((j) => j.job_key)).toEqual(['deploy']);

    // 3. Mark lint succeeded, test succeeded
    await updateJobStatus(lint.id, 'assigned');
    await updateJobStatus(lint.id, 'running');
    await updateJobStatus(lint.id, 'succeeded');

    await updateJobStatus(test.id, 'assigned');
    await updateJobStatus(test.id, 'running');
    await updateJobStatus(test.id, 'succeeded');

    const round3 = await evaluateAndPromoteDependentJobs(run.id);
    expect(round3.promoted.map((j) => j.job_key)).toEqual(['deploy']);

    const stagedAfterRound3 = await findStagedJobs(run.id);
    expect(stagedAfterRound3).toHaveLength(0);
  });

  it('cascades cancellations down the DAG when an upstream job fails', async () => {
    const run = await createWorkflowRun('dag-failure-cascade-test');

    const root = await createJob({
      workflowRunId: run.id,
      jobKey: 'root',
      needs: [],
      name: 'Root Job',
      command: 'exit 1',
      status: 'created',
    });

    const middle = await createJob({
      workflowRunId: run.id,
      jobKey: 'middle',
      needs: ['root'],
      name: 'Middle Job',
      command: 'echo middle',
      status: 'created',
    });

    const leaf = await createJob({
      workflowRunId: run.id,
      jobKey: 'leaf',
      needs: ['middle'],
      name: 'Leaf Job',
      command: 'echo leaf',
      status: 'created',
    });

    // Mark root as failed
    await updateJobStatus(root.id, 'queued');
    await updateJobStatus(root.id, 'assigned');
    await updateJobStatus(root.id, 'running');
    await updateJobStatus(root.id, 'failed', { error: 'Command failed with exit code 1' });

    // Evaluate DAG
    const result = await evaluateAndPromoteDependentJobs(run.id);
    expect(result.promoted).toHaveLength(0);
    expect(result.cancelled.map((j) => j.job_key).sort()).toEqual(['leaf', 'middle']);

    const updatedMiddle = await getJob(middle.id);
    const updatedLeaf = await getJob(leaf.id);
    expect(updatedMiddle?.status).toBe('cancelled');
    expect(updatedLeaf?.status).toBe('cancelled');

    // Workflow run should now be marked as failed
    const updatedRun = await getWorkflowRun(run.id);
    expect(updatedRun?.status).toBe('failed');
  });
});




