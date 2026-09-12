import type { WorkflowRunRecord, JobRecord, WorkflowDefinition } from '@mini-ci/types';
import {
  createWorkflowRun,
  getWorkflowRun,
  listWorkflowRuns,
  createJob,
  getJobsByWorkflowRun,
} from '@mini-ci/db';
import { parseWorkflowContent } from './workflow-parser.js';

export interface WorkflowSubmissionResult {
  run: WorkflowRunRecord;
  jobs: JobRecord[];
}

export async function submitWorkflow(
  yamlOrDef: string | WorkflowDefinition,
): Promise<WorkflowSubmissionResult> {
  let definition: WorkflowDefinition;

  if (typeof yamlOrDef === 'string') {
    definition = parseWorkflowContent(yamlOrDef);
  } else {
    definition = yamlOrDef;
  }

  const run = await createWorkflowRun(definition.name, 'running');

  const jobs: JobRecord[] = [];
  for (let i = 0; i < definition.steps.length; i++) {
    const step = definition.steps[i]!;
    const stepName = step.name ?? `Step ${i + 1}`;
    const image = step.image ?? definition.image;

    const job = await createJob({
      workflowRunId: run.id,
      name: stepName,
      command: step.run,
      image: image ?? null,
      timeoutSeconds: step.timeout_seconds ?? null,
      status: 'queued',
    });

    jobs.push(job);
  }

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
