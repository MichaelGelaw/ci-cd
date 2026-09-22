import type { WorkflowRunRecord, JobRecord, WorkflowDefinition, JobStatus } from '@mini-ci/types';
import {
  createWorkflowRun,
  getPool,
  getWorkflowRun,
  listWorkflowRuns,
  createJob,
  getJobsByWorkflowRun,
  cancelWorkflowRun,
} from '@mini-ci/db';
import type { CancelWorkflowRunResult, CreateWorkflowRunOptions } from '@mini-ci/db';
import { enqueueJob, publishJobCancellation } from '@mini-ci/queue';
import { parseWorkflowContent } from './workflow-parser.js';
import { recordWorkflowStatus } from '../metrics.js';

export interface WorkflowSubmissionResult {
  run: WorkflowRunRecord;
  jobs: JobRecord[];
}

export interface SubmitWorkflowOptions extends CreateWorkflowRunOptions {
  env?: Record<string, string>;
}

function buildJobCommand(baseCommand: string, env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) {
    return baseCommand;
  }
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}="${String(v).replace(/(["\\$`])/g, '\\$1')}"`)
    .join('\n');
  return `${exports}\n${baseCommand}`;
}

export async function submitWorkflow(
  yamlOrDef: string | WorkflowDefinition,
  options?: SubmitWorkflowOptions,
): Promise<WorkflowSubmissionResult> {
  let definition: WorkflowDefinition;

  if (typeof yamlOrDef === 'string') {
    definition = parseWorkflowContent(yamlOrDef);
  } else {
    definition = parseWorkflowContent(JSON.stringify(yamlOrDef));
  }

  const client = await getPool().connect();
  const jobs: JobRecord[] = [];
  let run: WorkflowRunRecord;
  try {
    await client.query('BEGIN');
    run = await createWorkflowRun(definition.name, 'running', options, client);

    if (definition.jobs && Object.keys(definition.jobs).length > 0) {
      for (const [key, jobDef] of Object.entries(definition.jobs)) {
        const jobName = jobDef.name ?? key;
        const image = jobDef.image ?? definition.image;
        const needs = Array.isArray(jobDef.needs)
          ? jobDef.needs
          : typeof jobDef.needs === 'string'
            ? [jobDef.needs]
            : [];

        // Combine step commands into a single script if multiple steps
        const steps = jobDef.steps ?? (jobDef.run ? [{ run: jobDef.run }] : []);
        const rawCommand = steps.map((step) => `sh -c '${step.run.replace(/'/g, "'\\''")}'`).join(' &&\n');
        const mergedEnv = { ...definition.env, ...jobDef.env, ...options?.env };
        const command = buildJobCommand(rawCommand, mergedEnv);

        const retryPolicy =
          jobDef.retry ??
          (jobDef.retries !== undefined ? { max_attempts: jobDef.retries + 1 } : undefined);

        const isRootJob = needs.length === 0;
        const status: JobStatus = isRootJob ? 'queued' : 'created';

        const job = await createJob({
          workflowRunId: run.id,
          jobKey: key,
          needs,
          name: jobName,
          command,
          image: image ?? null,
          timeoutSeconds: jobDef.timeout_seconds ?? null,
          priority: jobDef.priority ?? 0,
          status,
          retryPolicy,
          artifacts: jobDef.artifacts,
        }, client);

        jobs.push(job);
      }
    } else if (definition.steps) {
      for (let i = 0; i < definition.steps.length; i++) {
        const step = definition.steps[i]!;
        const stepName = step.name ?? `Step ${i + 1}`;
        const image = step.image ?? definition.image;
        const mergedEnv = { ...definition.env, ...options?.env };
        const command = buildJobCommand(step.run, mergedEnv);

        const retryPolicy =
          step.retry ?? (step.retries !== undefined ? { max_attempts: step.retries + 1 } : undefined);
        const job = await createJob({
          workflowRunId: run.id,
          jobKey: `step-${i + 1}`,
          needs: i > 0 ? [`step-${i}`] : [],
          name: stepName,
          command,
          image: image ?? null,
          timeoutSeconds: step.timeout_seconds ?? null,
          status: i === 0 ? 'queued' : 'created',
          retryPolicy,
          artifacts: step.artifacts,
        }, client);

        jobs.push(job);
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  for (const job of jobs.filter((job) => job.status === 'queued')) {
    try {
      await enqueueJob({
        jobId: job.id,
        workflowRunId: run.id,
        queuedAt: job.created_at,
        attempt: job.attempt,
        correlationId: run.id,
        traceId: run.id,
      });
    } catch {
      // The scheduler discovers queued jobs from PostgreSQL after Redis recovers.
    }
  }

  recordWorkflowStatus('running', options?.triggerEvent ?? undefined);

  return { run, jobs };
}

export async function getRunDetails(
  runId: string,
): Promise<{ run: WorkflowRunRecord; jobs: JobRecord[] } | null> {
  const run = await getWorkflowRun(runId);
  if (!run) {
    return null;
  }

  const jobs = await getJobsByWorkflowRun(runId);
  return { run, jobs };
}

export async function listRuns(
  limit: number = 20,
  offset: number = 0,
): Promise<WorkflowRunRecord[]> {
  return listWorkflowRuns(limit, offset);
}

export async function cancelWorkflowRunService(
  runId: string,
  reason: string = 'Cancelled by user request',
): Promise<CancelWorkflowRunResult> {
  const result = await cancelWorkflowRun(runId, reason);
  recordWorkflowStatus('cancelled');

  for (const job of result.cancelledJobs) {
    try {
      await publishJobCancellation(job.id, reason);
    } catch {
      // Best-effort signal
    }
  }

  return result;
}
