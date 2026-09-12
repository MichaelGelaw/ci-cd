import type {
  WorkflowRunRecord,
  JobRecord,
  JobAttemptRecord,
  JobStatus,
  RunStatus,
} from '@mini-ci/types';
import { getPool } from './connection.js';
import { assertValidTransition } from './state-machine.js';

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

  const query = `
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
  `;

  const { rows } = await pool.query<WorkflowRunRecord>(query, values);
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
}): Promise<JobRecord> {
  const pool = getPool();
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
      status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
      created_at::text;
    `,
    [
      params.workflowRunId,
      params.name,
      params.command,
      params.image ?? null,
      params.timeoutSeconds ?? null,
      params.priority ?? 0,
      params.maxAttempts ?? 1,
      params.status ?? 'created',
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
      created_at::text
    FROM jobs
    WHERE workflow_run_id = $1
    ORDER BY created_at ASC;
    `,
    [workflowRunId],
  );
  return rows;
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
