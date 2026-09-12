import {
  listQueuedJobs,
  listWorkers,
  assignJobToWorker,
  updateWorkerStatus,
  countActiveJobsForWorkflowRun,
  evaluateAndPromoteDependentJobs,
} from '@mini-ci/db';
import type { EvaluateDependenciesResult } from '@mini-ci/db';
import { enqueueJob, enqueueJobForWorker } from '@mini-ci/queue';
import { selectBestWorker } from './matcher.js';

export interface SchedulerOptions {
  maxConcurrencyPerWorkflow?: number;
  batchSize?: number;
}

export interface SchedulingDecision {
  jobId: string;
  jobName: string;
  workflowRunId: string;
  workerId: string;
  workerName: string;
  scheduledAt: string;
}

export class Scheduler {
  private options: Required<SchedulerOptions>;

  constructor(options: SchedulerOptions = {}) {
    this.options = {
      maxConcurrencyPerWorkflow: options.maxConcurrencyPerWorkflow ?? 10,
      batchSize: options.batchSize ?? 50,
    };
  }

  async evaluateDependencies(
    workflowRunId?: string,
  ): Promise<EvaluateDependenciesResult> {
    const result = await evaluateAndPromoteDependentJobs(workflowRunId);
    for (const job of result.promoted) {
      await enqueueJob({
        jobId: job.id,
        workflowRunId: job.workflow_run_id,
        queuedAt: job.created_at,
        attempt: job.attempt,
      });
    }
    return result;
  }

  async scheduleRound(): Promise<SchedulingDecision[]> {
    // 0. Advance DAG dependencies: promote ready created jobs to queued
    await this.evaluateDependencies();

    const decisions: SchedulingDecision[] = [];

    // 1. Fetch queued jobs ordered by priority DESC, created_at ASC
    const queuedJobs = await listQueuedJobs(this.options.batchSize);
    if (queuedJobs.length === 0) {
      return decisions;
    }

    // 2. Fetch ready workers
    const readyWorkers = await listWorkers({ status: 'ready' });
    if (readyWorkers.length === 0) {
      return decisions;
    }

    const availableWorkerPool = [...readyWorkers];
    const workflowConcurrencyMap = new Map<string, number>();

    for (const job of queuedJobs) {
      if (availableWorkerPool.length === 0) {
        break;
      }

      // Check workflow concurrency limits
      let activeCount = workflowConcurrencyMap.get(job.workflow_run_id);
      if (activeCount === undefined) {
        activeCount = await countActiveJobsForWorkflowRun(job.workflow_run_id);
        workflowConcurrencyMap.set(job.workflow_run_id, activeCount);
      }

      if (activeCount >= this.options.maxConcurrencyPerWorkflow) {
        continue;
      }

      // Find best matching worker
      const worker = selectBestWorker(job, availableWorkerPool);
      if (!worker) {
        continue;
      }

      // Atomically assign in PostgreSQL: queued -> assigned
      try {
        await assignJobToWorker(job.id, worker.id);
        await updateWorkerStatus(worker.id, 'busy');

        // Dispatch to worker's dedicated queue in Redis
        await enqueueJobForWorker(worker.id, {
          jobId: job.id,
          workflowRunId: job.workflow_run_id,
          queuedAt: new Date().toISOString(),
          attempt: job.attempt,
        });

        // Remove worker from available pool for this round
        const workerIndex = availableWorkerPool.findIndex((w) => w.id === worker.id);
        if (workerIndex !== -1) {
          availableWorkerPool.splice(workerIndex, 1);
        }

        // Increment active concurrency count for this workflow
        workflowConcurrencyMap.set(job.workflow_run_id, activeCount + 1);

        decisions.push({
          jobId: job.id,
          jobName: job.name,
          workflowRunId: job.workflow_run_id,
          workerId: worker.id,
          workerName: worker.name,
          scheduledAt: new Date().toISOString(),
        });
      } catch (err) {
        // Log assignment failure and continue
        console.error(
          `Failed to assign job ${job.id} to worker ${worker.id}: ${(err as Error).message}`,
        );
      }
    }

    return decisions;
  }
}
