import type {
  WorkflowRunRecord,
  JobRecord,
  JobAttemptRecord,
  JobStatus,
  RunStatus,
  WorkerRecord,
  WorkerStatus,
  RetryPolicy,
} from '@mini-ci/types';
import { randomUUID } from 'node:crypto';
import { getPool } from './connection.js';
import { assertValidTransition } from './state-machine.js';
import { calculateRetryDelay } from './retry.js';

export async function createWorkflowRun(
  workflowName: string,
  status: RunStatus = 'running',
): Promise<WorkflowRunRecord> {
  const pool = getPool();
  const { rows } = await pool.query<WorkflowRunRecord>(
    `
    INSERT INTO workflow_runs (workflow_name, status)
    VALUES ($1, $2)
    RETURNING
      id,
      workflow_name,
      status,
      started_at::text,
      finished_at::text,
      duration_ms,
      error,
      created_at::text;
    `,
    [workflowName, status],
  );

  return rows[0]!;
}

export async function updateWorkflowRun(
  id: string,
  updates: {
    status?: RunStatus;
    finished_at?: Date | string;
    duration_ms?: number;
    error?: string | null;
  },
): Promise<WorkflowRunRecord> {
  const pool = getPool();
  const setClauses: string[] = [];
  const values: unknown[] = [id];
  let paramIndex = 2;

  if (updates.status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`);
    values.push(updates.status);
  }
  if (updates.finished_at !== undefined) {
    setClauses.push(`finished_at = $${paramIndex++}`);
    values.push(updates.finished_at);
  }
  if (updates.duration_ms !== undefined) {
    setClauses.push(`duration_ms = $${paramIndex++}`);
    values.push(updates.duration_ms);
  }
  if (updates.error !== undefined) {
    setClauses.push(`error = $${paramIndex++}`);
    values.push(updates.error);
  }

  if (setClauses.length === 0) {
    const existing = await getWorkflowRun(id);
    if (!existing) {
      throw new Error(`Workflow run ${id} not found`);
    }
    return existing;
  }

  const { rows } = await pool.query<WorkflowRunRecord>(
    `
    UPDATE workflow_runs
    SET ${setClauses.join(', ')}
    WHERE id = $1
    RETURNING
      id,
      workflow_name,
      status,
      started_at::text,
      finished_at::text,
      duration_ms,
      error,
      created_at::text;
    `,
    values,
  );

  if (rows.length === 0) {
    throw new Error(`Workflow run ${id} not found`);
  }

  return rows[0]!;
}

export async function getWorkflowRun(id: string): Promise<WorkflowRunRecord | null> {
  const pool = getPool();
  const { rows } = await pool.query<WorkflowRunRecord>(
    `
    SELECT
      id,
      workflow_name,
      status,
      started_at::text,
      finished_at::text,
      duration_ms,
      error,
      created_at::text
    FROM workflow_runs
    WHERE id = $1;
    `,
    [id],
  );
  return rows[0] ?? null;
}

export async function listWorkflowRuns(
  limit: number = 20,
  offset: number = 0,
): Promise<WorkflowRunRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<WorkflowRunRecord>(
    `
    SELECT
      id,
      workflow_name,
      status,
      started_at::text,
      finished_at::text,
      duration_ms,
      error,
      created_at::text
    FROM workflow_runs
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2;
    `,
    [limit, offset],
  );
  return rows;
}

export async function createJob(params: {
  workflowRunId: string;
  name: string;
  command: string;
  image?: string | null;
  timeoutSeconds?: number | null;
  priority?: number;
  maxAttempts?: number;
  status?: JobStatus;
  retryPolicy?: RetryPolicy;
}): Promise<JobRecord> {
  const pool = getPool();
  const retryPolicy = params.retryPolicy ?? {};
  const maxAttempts = params.retryPolicy?.max_attempts ?? params.maxAttempts ?? 1;

  const { rows } = await pool.query<JobRecord>(
    `
    INSERT INTO jobs (
      workflow_run_id,
      name,
      command,
      image,
      timeout_seconds,
      priority,
      max_attempts,
      status,
      retry_policy
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING
      id,
      workflow_run_id,
      name,
      command,
      image,
      status,
      priority,
      attempt,
      max_attempts,
      worker_id,
      exit_code,
      stdout,
      stderr,
      error,
      timeout_seconds,
      started_at::text,
      finished_at::text,
      duration_ms,
      lease_token,
      lease_expires_at::text,
      lease_duration_seconds,
      retry_policy,
      next_retry_at::text,
      created_at::text;
    `,
    [
      params.workflowRunId,
      params.name,
      params.command,
      params.image ?? null,
      params.timeoutSeconds ?? null,
      params.priority ?? 0,
      maxAttempts,
      params.status ?? 'created',
      JSON.stringify(retryPolicy),
    ],
  );

  return rows[0]!;
}

export async function getJob(id: string): Promise<JobRecord | null> {
  const pool = getPool();
  const { rows } = await pool.query<JobRecord>(
    `
    SELECT
      id,
      workflow_run_id,
      name,
      command,
      image,
      status,
      priority,
      attempt,
      max_attempts,
      worker_id,
      exit_code,
      stdout,
      stderr,
      error,
      timeout_seconds,
      started_at::text,
      finished_at::text,
      duration_ms,
      lease_token,
      lease_expires_at::text,
      lease_duration_seconds,
      retry_policy,
      next_retry_at::text,
      created_at::text
    FROM jobs
    WHERE id = $1;
    `,
    [id],
  );
  return rows[0] ?? null;
}

export async function getJobsByWorkflowRun(workflowRunId: string): Promise<JobRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<JobRecord>(
    `
    SELECT
      id,
      workflow_run_id,
      name,
      command,
      image,
      status,
      priority,
      attempt,
      max_attempts,
      worker_id,
      exit_code,
      stdout,
      stderr,
      error,
      timeout_seconds,
      started_at::text,
      finished_at::text,
      duration_ms,
      lease_token,
      lease_expires_at::text,
      lease_duration_seconds,
      retry_policy,
      next_retry_at::text,
      created_at::text
    FROM jobs
    WHERE workflow_run_id = $1
    ORDER BY created_at ASC;
    `,
    [workflowRunId],
  );
  return rows;
}

export async function listQueuedJobs(limit: number = 100): Promise<JobRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<JobRecord>(
    `
    SELECT
      id,
      workflow_run_id,
      name,
      command,
      image,
      status,
      priority,
      attempt,
      max_attempts,
      worker_id,
      exit_code,
      stdout,
      stderr,
      error,
      timeout_seconds,
      started_at::text,
      finished_at::text,
      duration_ms,
      lease_token,
      lease_expires_at::text,
      lease_duration_seconds,
      retry_policy,
      next_retry_at::text,
      created_at::text
    FROM jobs
    WHERE status = 'queued'
    ORDER BY priority DESC, created_at ASC
    LIMIT $1;
    `,
    [limit],
  );
  return rows;
}

export async function countActiveJobsForWorkflowRun(workflowRunId: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query<{ count: string }>(
    `
    SELECT COUNT(*)::text AS count
    FROM jobs
    WHERE workflow_run_id = $1
      AND status IN ('assigned', 'running');
    `,
    [workflowRunId],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

export class LeaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseConflictError';
  }
}

export async function assignJobToWorker(
  jobId: string,
  workerId: string,
  leaseDurationSeconds: number = 30,
): Promise<JobRecord> {
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + leaseDurationSeconds * 1000);
  return updateJobStatus(jobId, 'assigned', {
    workerId,
    leaseToken,
    leaseExpiresAt,
    leaseDurationSeconds,
  });
}

export async function updateJobStatus(
  jobId: string,
  nextStatus: JobStatus,
  updates: {
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string | null;
    workerId?: string | null;
    startedAt?: Date | string;
    finishedAt?: Date | string;
    durationMs?: number | null;
    leaseToken?: string | null;
    leaseExpiresAt?: Date | string | null;
    leaseDurationSeconds?: number | null;
    nextRetryAt?: Date | string | null;
    retryPolicy?: RetryPolicy;
  } = {},
): Promise<JobRecord> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Row lock for atomic transition verification
    const { rows: existingRows } = await client.query<{ status: JobStatus }>(
      'SELECT status FROM jobs WHERE id = $1 FOR UPDATE;',
      [jobId],
    );

    if (existingRows.length === 0) {
      throw new Error(`Job ${jobId} not found`);
    }

    const currentStatus = existingRows[0]!.status;
    assertValidTransition(currentStatus, nextStatus);

    const setClauses: string[] = ['status = $2'];
    const values: unknown[] = [jobId, nextStatus];
    let paramIndex = 3;

    if (updates.exitCode !== undefined) {
      setClauses.push(`exit_code = $${paramIndex++}`);
      values.push(updates.exitCode);
    }
    if (updates.stdout !== undefined) {
      setClauses.push(`stdout = $${paramIndex++}`);
      values.push(updates.stdout);
    }
    if (updates.stderr !== undefined) {
      setClauses.push(`stderr = $${paramIndex++}`);
      values.push(updates.stderr);
    }
    if (updates.error !== undefined) {
      setClauses.push(`error = $${paramIndex++}`);
      values.push(updates.error);
    }
    if (updates.workerId !== undefined) {
      setClauses.push(`worker_id = $${paramIndex++}`);
      values.push(updates.workerId);
    }
    if (updates.startedAt !== undefined) {
      setClauses.push(`started_at = $${paramIndex++}`);
      values.push(updates.startedAt);
    }
    if (updates.finishedAt !== undefined) {
      setClauses.push(`finished_at = $${paramIndex++}`);
      values.push(updates.finishedAt);
    }
    if (updates.durationMs !== undefined) {
      setClauses.push(`duration_ms = $${paramIndex++}`);
      values.push(updates.durationMs);
    }
    if (updates.leaseToken !== undefined) {
      setClauses.push(`lease_token = $${paramIndex++}`);
      values.push(updates.leaseToken);
    } else if (['succeeded', 'failed', 'cancelled', 'timed_out', 'retrying'].includes(nextStatus)) {
      // Clear lease on terminal states or when retrying
      setClauses.push('lease_token = NULL');
    }
    if (updates.leaseExpiresAt !== undefined) {
      setClauses.push(`lease_expires_at = $${paramIndex++}`);
      values.push(updates.leaseExpiresAt);
    } else if (['succeeded', 'failed', 'cancelled', 'timed_out', 'retrying'].includes(nextStatus)) {
      setClauses.push('lease_expires_at = NULL');
    }
    if (updates.leaseDurationSeconds !== undefined) {
      setClauses.push(`lease_duration_seconds = $${paramIndex++}`);
      values.push(updates.leaseDurationSeconds);
    }
    if (updates.nextRetryAt !== undefined) {
      setClauses.push(`next_retry_at = $${paramIndex++}`);
      values.push(updates.nextRetryAt);
    } else if (['succeeded', 'failed', 'cancelled'].includes(nextStatus)) {
      setClauses.push('next_retry_at = NULL');
    }
    if (updates.retryPolicy !== undefined) {
      setClauses.push(`retry_policy = $${paramIndex++}`);
      values.push(JSON.stringify(updates.retryPolicy));
    }

    const updateQuery = `
      UPDATE jobs
      SET ${setClauses.join(', ')}
      WHERE id = $1
      RETURNING
        id,
        workflow_run_id,
        name,
        command,
        image,
        status,
        priority,
        attempt,
        max_attempts,
        worker_id,
        exit_code,
        stdout,
        stderr,
        error,
        timeout_seconds,
        started_at::text,
        finished_at::text,
        duration_ms,
        lease_token,
        lease_expires_at::text,
        lease_duration_seconds,
        retry_policy,
        next_retry_at::text,
        created_at::text;
    `;

    const { rows: updatedRows } = await client.query<JobRecord>(updateQuery, values);
    await client.query('COMMIT');
    return updatedRows[0]!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function grantJobLease(
  jobId: string,
  workerId: string,
  durationSeconds: number = 30,
): Promise<{ job: JobRecord; leaseToken: string; expiresAt: Date }> {
  const leaseToken = randomUUID();
  const expiresAt = new Date(Date.now() + durationSeconds * 1000);
  const pool = getPool();
  const { rows } = await pool.query<JobRecord>(
    `
    UPDATE jobs
    SET
      worker_id = $2,
      lease_token = $3,
      lease_expires_at = $4,
      lease_duration_seconds = $5
    WHERE id = $1
    RETURNING
      id,
      workflow_run_id,
      name,
      command,
      image,
      status,
      priority,
      attempt,
      max_attempts,
      worker_id,
      exit_code,
      stdout,
      stderr,
      error,
      timeout_seconds,
      started_at::text,
      finished_at::text,
      duration_ms,
      lease_token,
      lease_expires_at::text,
      lease_duration_seconds,
      retry_policy,
      next_retry_at::text,
      created_at::text;
    `,
    [jobId, workerId, leaseToken, expiresAt, durationSeconds],
  );

  if (rows.length === 0) {
    throw new Error(`Job ${jobId} not found`);
  }

  return { job: rows[0]!, leaseToken, expiresAt };
}

export async function renewJobLease(
  jobId: string,
  leaseToken: string,
  durationSeconds: number = 30,
): Promise<{ job: JobRecord; leaseExpiresAt: string; lease_expires_at: string }> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query<JobRecord>(
      `
      SELECT
        id,
        status,
        lease_token,
        lease_expires_at::text,
        (lease_expires_at < NOW()) AS is_expired
      FROM jobs
      WHERE id = $1
      FOR UPDATE;
      `,
      [jobId],
    );

    if (existingRows.length === 0) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job = existingRows[0]!;

    if (job.status !== 'assigned' && job.status !== 'running') {
      throw new LeaseConflictError(
        `Cannot renew lease for job in status '${job.status}': job is not active`,
      );
    }

    if (!job.lease_token || job.lease_token !== leaseToken) {
      throw new LeaseConflictError(
        `Invalid lease token for job ${jobId}: lease ownership mismatch`,
      );
    }

    const isExpired = (job as unknown as { is_expired: boolean }).is_expired;
    if (isExpired) {
      throw new LeaseConflictError(
        `Lease for job ${jobId} has expired and cannot be renewed`,
      );
    }

    const { rows: updatedRows } = await client.query<JobRecord>(
      `
      UPDATE jobs
      SET
        lease_expires_at = NOW() + ($2 * interval '1 second'),
        lease_duration_seconds = $2
      WHERE id = $1
      RETURNING
        id,
        workflow_run_id,
        name,
        command,
        image,
        status,
        priority,
        attempt,
        max_attempts,
        worker_id,
        exit_code,
        stdout,
        stderr,
        error,
        timeout_seconds,
        started_at::text,
        finished_at::text,
        duration_ms,
        lease_token,
        lease_expires_at::text,
        lease_duration_seconds,
        retry_policy,
        next_retry_at::text,
        created_at::text;
      `,
      [jobId, durationSeconds],
    );

    await client.query('COMMIT');

    const updatedJob = updatedRows[0]!;
    return {
      job: updatedJob,
      leaseExpiresAt: updatedJob.lease_expires_at!,
      lease_expires_at: updatedJob.lease_expires_at!,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseJobLease(
  jobId: string,
  leaseToken?: string,
): Promise<JobRecord> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query<JobRecord>(
      'SELECT id, lease_token FROM jobs WHERE id = $1 FOR UPDATE;',
      [jobId],
    );

    if (existingRows.length === 0) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job = existingRows[0]!;
    if (leaseToken && job.lease_token && job.lease_token !== leaseToken) {
      throw new LeaseConflictError(`Invalid lease token for job ${jobId}`);
    }

    const { rows: updatedRows } = await client.query<JobRecord>(
      `
      UPDATE jobs
      SET
        lease_token = NULL,
        lease_expires_at = NULL
      WHERE id = $1
      RETURNING
        id,
        workflow_run_id,
        name,
        command,
        image,
        status,
        priority,
        attempt,
        max_attempts,
        worker_id,
        exit_code,
        stdout,
        stderr,
        error,
        timeout_seconds,
        started_at::text,
        finished_at::text,
        duration_ms,
        lease_token,
        lease_expires_at::text,
        lease_duration_seconds,
        retry_policy,
        next_retry_at::text,
        created_at::text;
      `,
      [jobId],
    );

    await client.query('COMMIT');
    return updatedRows[0]!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function findExpiredLeases(
  gracePeriodSeconds: number = 0,
): Promise<JobRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<JobRecord>(
    `
    SELECT
      id,
      workflow_run_id,
      name,
      command,
      image,
      status,
      priority,
      attempt,
      max_attempts,
      worker_id,
      exit_code,
      stdout,
      stderr,
      error,
      timeout_seconds,
      started_at::text,
      finished_at::text,
      duration_ms,
      lease_token,
      lease_expires_at::text,
      lease_duration_seconds,
      retry_policy,
      next_retry_at::text,
      created_at::text
    FROM jobs
    WHERE status IN ('assigned', 'running')
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < NOW() - ($1 * interval '1 second')
    ORDER BY lease_expires_at ASC;
    `,
    [gracePeriodSeconds],
  );
  return rows;
}

export async function findDueRetryingJobs(limit: number = 100): Promise<JobRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<JobRecord>(
    `
    SELECT
      id,
      workflow_run_id,
      name,
      command,
      image,
      status,
      priority,
      attempt,
      max_attempts,
      worker_id,
      exit_code,
      stdout,
      stderr,
      error,
      timeout_seconds,
      started_at::text,
      finished_at::text,
      duration_ms,
      lease_token,
      lease_expires_at::text,
      lease_duration_seconds,
      retry_policy,
      next_retry_at::text,
      created_at::text
    FROM jobs
    WHERE status = 'retrying'
      AND (next_retry_at IS NULL OR next_retry_at <= NOW())
    ORDER BY next_retry_at ASC NULLS FIRST, priority DESC, created_at ASC
    LIMIT $1;
    `,
    [limit],
  );
  return rows;
}

export async function requeueJobForRetry(jobId: string): Promise<JobRecord> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: existingRows } = await client.query<{ status: JobStatus }>(
      'SELECT status FROM jobs WHERE id = $1 FOR UPDATE;',
      [jobId],
    );

    if (existingRows.length === 0) {
      throw new Error(`Job ${jobId} not found`);
    }

    const currentStatus = existingRows[0]!.status;
    assertValidTransition(currentStatus, 'queued');

    const { rows: updatedRows } = await client.query<JobRecord>(
      `
      UPDATE jobs
      SET
        status = 'queued',
        attempt = attempt + 1,
        worker_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_retry_at = NULL,
        exit_code = NULL,
        error = NULL,
        started_at = NULL,
        finished_at = NULL,
        duration_ms = NULL
      WHERE id = $1
      RETURNING
        id,
        workflow_run_id,
        name,
        command,
        image,
        status,
        priority,
        attempt,
        max_attempts,
        worker_id,
        exit_code,
        stdout,
        stderr,
        error,
        timeout_seconds,
        started_at::text,
        finished_at::text,
        duration_ms,
        lease_token,
        lease_expires_at::text,
        lease_duration_seconds,
        retry_policy,
        next_retry_at::text,
        created_at::text;
      `,
      [jobId],
    );

    await client.query('COMMIT');
    return updatedRows[0]!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function recordJobAttempt(params: {
  jobId: string;
  attemptNumber: number;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string | null;
  startedAt?: Date | string;
  finishedAt?: Date | string;
  durationMs?: number | null;
}): Promise<JobAttemptRecord> {
  const pool = getPool();
  const { rows } = await pool.query<JobAttemptRecord>(
    `
    INSERT INTO job_attempts (
      job_id,
      attempt_number,
      status,
      exit_code,
      stdout,
      stderr,
      error,
      started_at,
      finished_at,
      duration_ms
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9, $10)
    ON CONFLICT (job_id, attempt_number)
    DO UPDATE SET
      status = EXCLUDED.status,
      exit_code = COALESCE(EXCLUDED.exit_code, job_attempts.exit_code),
      stdout = CASE WHEN EXCLUDED.stdout <> '' THEN EXCLUDED.stdout ELSE job_attempts.stdout END,
      stderr = CASE WHEN EXCLUDED.stderr <> '' THEN EXCLUDED.stderr ELSE job_attempts.stderr END,
      error = COALESCE(EXCLUDED.error, job_attempts.error),
      finished_at = COALESCE(EXCLUDED.finished_at, job_attempts.finished_at),
      duration_ms = COALESCE(EXCLUDED.duration_ms, job_attempts.duration_ms)
    RETURNING
      id,
      job_id,
      attempt_number,
      status,
      exit_code,
      stdout,
      stderr,
      error,
      started_at::text,
      finished_at::text,
      duration_ms;
    `,
    [
      params.jobId,
      params.attemptNumber,
      params.status,
      params.exitCode ?? null,
      params.stdout ?? '',
      params.stderr ?? '',
      params.error ?? null,
      params.startedAt ?? null,
      params.finishedAt ?? null,
      params.durationMs ?? null,
    ],
  );

  return rows[0]!;
}

export async function getJobAttempts(jobId: string): Promise<JobAttemptRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<JobAttemptRecord>(
    `
    SELECT
      id,
      job_id,
      attempt_number,
      status,
      exit_code,
      stdout,
      stderr,
      error,
      started_at::text,
      finished_at::text,
      duration_ms
    FROM job_attempts
    WHERE job_id = $1
    ORDER BY attempt_number ASC;
    `,
    [jobId],
  );
  return rows;
}

export async function registerWorker(params: {
  id: string;
  name: string;
  address?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): Promise<WorkerRecord> {
  const pool = getPool();
  const tags = params.tags ?? [];
  const metadata = JSON.stringify(params.metadata ?? {});
  const address = params.address ?? null;

  const { rows } = await pool.query<WorkerRecord>(
    `
    INSERT INTO workers (
      id,
      name,
      status,
      address,
      tags,
      metadata,
      registered_at,
      last_heartbeat_at,
      updated_at
    )
    VALUES ($1, $2, 'ready', $3, $4, $5::jsonb, NOW(), NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      address = EXCLUDED.address,
      tags = EXCLUDED.tags,
      metadata = EXCLUDED.metadata,
      status = 'ready',
      last_heartbeat_at = NOW(),
      updated_at = NOW()
    RETURNING
      id,
      name,
      status,
      address,
      tags,
      metadata,
      registered_at::text,
      last_heartbeat_at::text,
      created_at::text,
      updated_at::text;
    `,
    [params.id, params.name, address, tags, metadata],
  );

  return rows[0]!;
}

export async function getWorker(id: string): Promise<WorkerRecord | null> {
  const pool = getPool();
  const { rows } = await pool.query<WorkerRecord>(
    `
    SELECT
      id,
      name,
      status,
      address,
      tags,
      metadata,
      registered_at::text,
      last_heartbeat_at::text,
      created_at::text,
      updated_at::text
    FROM workers
    WHERE id = $1;
    `,
    [id],
  );
  return rows[0] ?? null;
}

export async function listWorkers(filter: {
  status?: WorkerStatus;
  limit?: number;
  offset?: number;
} = {}): Promise<WorkerRecord[]> {
  const pool = getPool();
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (filter.status) {
    conditions.push(`status = $${paramIndex++}`);
    values.push(filter.status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  values.push(limit, offset);

  const query = `
    SELECT
      id,
      name,
      status,
      address,
      tags,
      metadata,
      registered_at::text,
      last_heartbeat_at::text,
      created_at::text,
      updated_at::text
    FROM workers
    ${whereClause}
    ORDER BY registered_at DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex++};
  `;

  const { rows } = await pool.query<WorkerRecord>(query, values);
  return rows;
}

export async function updateWorkerStatus(id: string, status: WorkerStatus): Promise<WorkerRecord> {
  const pool = getPool();
  const { rows } = await pool.query<WorkerRecord>(
    `
    UPDATE workers
    SET
      status = $2,
      updated_at = NOW()
    WHERE id = $1
    RETURNING
      id,
      name,
      status,
      address,
      tags,
      metadata,
      registered_at::text,
      last_heartbeat_at::text,
      created_at::text,
      updated_at::text;
    `,
    [id, status],
  );

  if (rows.length === 0) {
    throw new Error(`Worker ${id} not found`);
  }

  return rows[0]!;
}

export async function touchWorkerHeartbeat(
  id: string,
  status?: WorkerStatus,
): Promise<WorkerRecord> {
  const pool = getPool();
  const setClauses: string[] = ['last_heartbeat_at = NOW()', 'updated_at = NOW()'];
  const values: unknown[] = [id];
  let paramIndex = 2;

  if (status !== undefined) {
    setClauses.push(`status = $${paramIndex++}`);
    values.push(status);
  }

  const { rows } = await pool.query<WorkerRecord>(
    `
    UPDATE workers
    SET ${setClauses.join(', ')}
    WHERE id = $1
    RETURNING
      id,
      name,
      status,
      address,
      tags,
      metadata,
      registered_at::text,
      last_heartbeat_at::text,
      created_at::text,
      updated_at::text;
    `,
    values,
  );

  if (rows.length === 0) {
    throw new Error(`Worker ${id} not found`);
  }

  return rows[0]!;
}

export async function reapDeadWorkers(timeoutSeconds: number = 30): Promise<WorkerRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<WorkerRecord>(
    `
    UPDATE workers
    SET
      status = 'offline',
      updated_at = NOW()
    WHERE status IN ('ready', 'busy')
      AND last_heartbeat_at < NOW() - ($1 || ' seconds')::interval
    RETURNING
      id,
      name,
      status,
      address,
      tags,
      metadata,
      registered_at::text,
      last_heartbeat_at::text,
      created_at::text,
      updated_at::text;
    `,
    [timeoutSeconds],
  );
  return rows;
}

export async function findStaleWorkers(timeoutSeconds: number = 30): Promise<WorkerRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<WorkerRecord>(
    `
    SELECT
      id,
      name,
      status,
      address,
      tags,
      metadata,
      registered_at::text,
      last_heartbeat_at::text,
      created_at::text,
      updated_at::text
    FROM workers
    WHERE status IN ('ready', 'busy')
      AND last_heartbeat_at < NOW() - ($1 || ' seconds')::interval
    ORDER BY last_heartbeat_at ASC;
    `,
    [timeoutSeconds],
  );
  return rows;
}

export interface FindRecoverableJobsOptions {
  leaseGracePeriodSeconds?: number;
  heartbeatTimeoutSeconds?: number;
}

export async function findRecoverableJobs(
  options: FindRecoverableJobsOptions = {},
): Promise<JobRecord[]> {
  const leaseGracePeriod = options.leaseGracePeriodSeconds ?? 0;
  const heartbeatTimeout = options.heartbeatTimeoutSeconds ?? 30;
  const pool = getPool();

  const { rows } = await pool.query<JobRecord>(
    `
    SELECT
      j.id,
      j.workflow_run_id,
      j.name,
      j.command,
      j.image,
      j.status,
      j.priority,
      j.attempt,
      j.max_attempts,
      j.worker_id,
      j.exit_code,
      j.stdout,
      j.stderr,
      j.error,
      j.timeout_seconds,
      j.started_at::text,
      j.finished_at::text,
      j.duration_ms,
      j.lease_token,
      j.lease_expires_at::text,
      j.lease_duration_seconds,
      j.retry_policy,
      j.next_retry_at::text,
      j.created_at::text
    FROM jobs j
    LEFT JOIN workers w ON j.worker_id = w.id
    WHERE j.status IN ('assigned', 'running')
      AND (
        (j.lease_expires_at IS NOT NULL AND j.lease_expires_at < NOW() - ($1 * interval '1 second'))
        OR
        (j.worker_id IS NOT NULL AND w.status = 'offline')
        OR
        (j.worker_id IS NOT NULL AND w.last_heartbeat_at < NOW() - ($2 * interval '1 second'))
        OR
        (j.worker_id IS NOT NULL AND w.id IS NULL)
      )
    ORDER BY j.lease_expires_at ASC NULLS FIRST, j.created_at ASC;
    `,
    [leaseGracePeriod, heartbeatTimeout],
  );

  return rows;
}

export interface RecoverJobOptions {
  immediateRequeue?: boolean;
}

export interface RecoverJobResult {
  job: JobRecord;
  action: 'retrying' | 'requeued' | 'failed' | 'ignored';
  reason: string;
}

export async function recoverJob(
  jobId: string,
  reason?: string,
  options: RecoverJobOptions = {},
): Promise<RecoverJobResult> {
  const failureReason = reason ?? 'Worker failure: worker crashed or lease expired';
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<JobRecord>(
      `
      SELECT
        id,
        workflow_run_id,
        name,
        command,
        image,
        status,
        priority,
        attempt,
        max_attempts,
        worker_id,
        exit_code,
        stdout,
        stderr,
        error,
        timeout_seconds,
        started_at::text,
        finished_at::text,
        duration_ms,
        lease_token,
        lease_expires_at::text,
        lease_duration_seconds,
        retry_policy,
        next_retry_at::text,
        created_at::text
      FROM jobs
      WHERE id = $1
      FOR UPDATE;
      `,
      [jobId],
    );

    if (rows.length === 0) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job = rows[0]!;

    // Only active jobs (assigned or running) are eligible for recovery
    if (job.status !== 'assigned' && job.status !== 'running') {
      await client.query('ROLLBACK');
      return {
        job,
        action: 'ignored',
        reason: `Job is in status '${job.status}', not eligible for recovery`,
      };
    }

    const finishedAt = new Date();
    const durationMs = job.started_at
      ? Math.max(0, finishedAt.getTime() - new Date(job.started_at).getTime())
      : null;

    // Record attempt as failed due to worker failure
    await client.query(
      `
      INSERT INTO job_attempts (
        job_id,
        attempt_number,
        status,
        exit_code,
        stdout,
        stderr,
        error,
        started_at,
        finished_at,
        duration_ms
      )
      VALUES ($1, $2, 'failed', 1, $3, $4, $5, COALESCE($6, NOW()), $7, $8)
      ON CONFLICT (job_id, attempt_number)
      DO UPDATE SET
        status = 'failed',
        exit_code = 1,
        error = EXCLUDED.error,
        finished_at = EXCLUDED.finished_at,
        duration_ms = EXCLUDED.duration_ms;
      `,
      [
        job.id,
        job.attempt,
        job.stdout ?? '',
        job.stderr ?? '',
        failureReason,
        job.started_at ?? null,
        finishedAt,
        durationMs,
      ],
    );

    const isRetryable = job.attempt < job.max_attempts;

    if (isRetryable) {
      // Transition: assigned/running -> failed
      await client.query(
        `
        UPDATE jobs
        SET
          status = 'failed',
          error = $2,
          finished_at = $3,
          duration_ms = $4,
          lease_token = NULL,
          lease_expires_at = NULL
        WHERE id = $1;
        `,
        [job.id, failureReason, finishedAt, durationMs],
      );

      if (options.immediateRequeue) {
        // Transition: failed -> retrying -> queued
        await client.query(
          `
          UPDATE jobs
          SET status = 'retrying'
          WHERE id = $1;
          `,
          [job.id],
        );

        const { rows: requeuedRows } = await client.query<JobRecord>(
          `
          UPDATE jobs
          SET
            status = 'queued',
            attempt = attempt + 1,
            worker_id = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            next_retry_at = NULL,
            exit_code = NULL,
            error = NULL,
            started_at = NULL,
            finished_at = NULL,
            duration_ms = NULL
          WHERE id = $1
          RETURNING
            id,
            workflow_run_id,
            name,
            command,
            image,
            status,
            priority,
            attempt,
            max_attempts,
            worker_id,
            exit_code,
            stdout,
            stderr,
            error,
            timeout_seconds,
            started_at::text,
            finished_at::text,
            duration_ms,
            lease_token,
            lease_expires_at::text,
            lease_duration_seconds,
            retry_policy,
            next_retry_at::text,
            created_at::text;
          `,
          [job.id],
        );

        await client.query('COMMIT');
        return {
          job: requeuedRows[0]!,
          action: 'requeued',
          reason: failureReason,
        };
      } else {
        // Transition to retrying with exponential backoff
        const delaySeconds = calculateRetryDelay(job.attempt, job.retry_policy);
        const nextRetryAt = new Date(Date.now() + delaySeconds * 1000);

        const { rows: retryingRows } = await client.query<JobRecord>(
          `
          UPDATE jobs
          SET
            status = 'retrying',
            next_retry_at = $2,
            worker_id = NULL
          WHERE id = $1
          RETURNING
            id,
            workflow_run_id,
            name,
            command,
            image,
            status,
            priority,
            attempt,
            max_attempts,
            worker_id,
            exit_code,
            stdout,
            stderr,
            error,
            timeout_seconds,
            started_at::text,
            finished_at::text,
            duration_ms,
            lease_token,
            lease_expires_at::text,
            lease_duration_seconds,
            retry_policy,
            next_retry_at::text,
            created_at::text;
          `,
          [job.id, nextRetryAt],
        );

        await client.query('COMMIT');
        return {
          job: retryingRows[0]!,
          action: 'retrying',
          reason: failureReason,
        };
      }
    } else {
      // Retries exhausted: transition to terminal failed status
      const { rows: failedRows } = await client.query<JobRecord>(
        `
        UPDATE jobs
        SET
          status = 'failed',
          error = $2,
          finished_at = $3,
          duration_ms = $4,
          lease_token = NULL,
          lease_expires_at = NULL
        WHERE id = $1
        RETURNING
          id,
          workflow_run_id,
          name,
          command,
          image,
          status,
          priority,
          attempt,
          max_attempts,
          worker_id,
          exit_code,
          stdout,
          stderr,
          error,
          timeout_seconds,
          started_at::text,
          finished_at::text,
          duration_ms,
          lease_token,
          lease_expires_at::text,
          lease_duration_seconds,
          retry_policy,
          next_retry_at::text,
          created_at::text;
        `,
        [job.id, failureReason, finishedAt, durationMs],
      );

      // Check sibling jobs and mark workflow_run failed if all terminal
      const { rows: siblingRows } = await client.query<JobRecord>(
        'SELECT status, duration_ms FROM jobs WHERE workflow_run_id = $1;',
        [job.workflow_run_id],
      );

      const allTerminal = siblingRows.every((j) =>
        ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(j.status),
      );

      if (allTerminal) {
        const totalDuration = siblingRows.reduce((acc, j) => acc + (j.duration_ms ?? 0), 0);
        await client.query(
          `
          UPDATE workflow_runs
          SET
            status = 'failed',
            finished_at = NOW(),
            duration_ms = $2,
            error = 'One or more jobs failed, timed out, or were cancelled'
          WHERE id = $1;
          `,
          [job.workflow_run_id, totalDuration],
        );
      }

      await client.query('COMMIT');
      return {
        job: failedRows[0]!,
        action: 'failed',
        reason: failureReason,
      };
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function recoverStaleJobs(
  options: FindRecoverableJobsOptions = {},
): Promise<RecoverJobResult[]> {
  const recoverableJobs = await findRecoverableJobs(options);
  const results: RecoverJobResult[] = [];

  for (const job of recoverableJobs) {
    const isLeaseExpired =
      job.lease_expires_at && new Date(job.lease_expires_at) < new Date();
    const reason = isLeaseExpired
      ? `Worker failure: lease expired for worker ${job.worker_id ?? 'unknown'}`
      : `Worker failure: worker ${job.worker_id ?? 'unknown'} is offline or unresponsive`;

    const result = await recoverJob(job.id, reason);
    results.push(result);
  }

  return results;
}

export interface CancelWorkflowRunResult {
  run: WorkflowRunRecord;
  cancelledJobs: JobRecord[];
}

export async function cancelWorkflowRun(
  workflowRunId: string,
  reason: string = 'Cancelled by user request',
): Promise<CancelWorkflowRunResult> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock workflow run
    const { rows: runRows } = await client.query<WorkflowRunRecord>(
      'SELECT id, workflow_name, status, started_at::text, finished_at::text, duration_ms, error, created_at::text FROM workflow_runs WHERE id = $1 FOR UPDATE;',
      [workflowRunId],
    );

    if (runRows.length === 0) {
      throw new Error(`Workflow run ${workflowRunId} not found`);
    }

    // 2. Cancel all non-terminal jobs
    const { rows: cancelledJobs } = await client.query<JobRecord>(
      `
      UPDATE jobs
      SET
        status = 'cancelled',
        error = $2,
        finished_at = COALESCE(finished_at, NOW()),
        lease_token = NULL,
        lease_expires_at = NULL,
        next_retry_at = NULL
      WHERE workflow_run_id = $1
        AND status IN ('created', 'queued', 'assigned', 'running', 'retrying')
      RETURNING
        id,
        workflow_run_id,
        name,
        command,
        image,
        status,
        priority,
        attempt,
        max_attempts,
        worker_id,
        exit_code,
        stdout,
        stderr,
        error,
        timeout_seconds,
        started_at::text,
        finished_at::text,
        duration_ms,
        lease_token,
        lease_expires_at::text,
        lease_duration_seconds,
        retry_policy,
        next_retry_at::text,
        created_at::text;
      `,
      [workflowRunId, reason],
    );

    // 3. Record attempt as cancelled for each job
    for (const job of cancelledJobs) {
      await client.query(
        `
        INSERT INTO job_attempts (
          job_id,
          attempt_number,
          status,
          exit_code,
          stdout,
          stderr,
          error,
          started_at,
          finished_at,
          duration_ms
        )
        VALUES ($1, $2, 'cancelled', NULL, $3, $4, $5, COALESCE($6, NOW()), NOW(), NULL)
        ON CONFLICT (job_id, attempt_number)
        DO UPDATE SET
          status = 'cancelled',
          error = EXCLUDED.error,
          finished_at = EXCLUDED.finished_at;
        `,
        [job.id, job.attempt, job.stdout ?? '', job.stderr ?? '', reason, job.started_at ?? null],
      );
    }

    // 4. Update workflow_run status to cancelled
    const { rows: updatedRunRows } = await client.query<WorkflowRunRecord>(
      `
      UPDATE workflow_runs
      SET
        status = 'cancelled',
        finished_at = COALESCE(finished_at, NOW()),
        error = $2
      WHERE id = $1
      RETURNING
        id,
        workflow_name,
        status,
        started_at::text,
        finished_at::text,
        duration_ms,
        error,
        created_at::text;
      `,
      [workflowRunId, reason],
    );

    await client.query('COMMIT');
    return {
      run: updatedRunRows[0]!,
      cancelledJobs,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


