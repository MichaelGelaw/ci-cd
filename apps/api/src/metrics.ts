import client, { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { getQueueLength, getProcessingLength } from '@mini-ci/queue';
import { listWorkers } from '@mini-ci/db';

export const register = new Registry();

// Enable default Node.js process and runtime metrics
collectDefaultMetrics({ register, prefix: 'minici_' });

// HTTP Request Metrics
export const httpRequestsTotal = new Counter({
  name: 'minici_http_requests_total',
  help: 'Total number of HTTP requests processed by mini-ci API',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: 'minici_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// Workflow Metrics
export const workflowsTotal = new Counter({
  name: 'minici_workflows_total',
  help: 'Total number of workflows recorded by status and trigger',
  labelNames: ['status', 'trigger_event'] as const,
  registers: [register],
});

export const workflowDuration = new Histogram({
  name: 'minici_workflow_duration_seconds',
  help: 'Workflow execution duration in seconds',
  labelNames: ['status'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

// Job Metrics
export const jobsTotal = new Counter({
  name: 'minici_jobs_total',
  help: 'Total number of job status transitions and terminal states',
  labelNames: ['status'] as const,
  registers: [register],
});

export const jobDuration = new Histogram({
  name: 'minici_job_duration_seconds',
  help: 'Job execution duration in seconds',
  labelNames: ['status'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [register],
});

// Worker Metrics
export const workersRegisteredTotal = new Counter({
  name: 'minici_workers_registered_total',
  help: 'Total number of worker registrations',
  registers: [register],
});

export const workerHeartbeatsTotal = new Counter({
  name: 'minici_worker_heartbeats_total',
  help: 'Total number of worker heartbeats received',
  labelNames: ['status'] as const,
  registers: [register],
});

export const activeWorkersGauge = new Gauge({
  name: 'minici_active_workers',
  help: 'Current count of registered workers by status',
  labelNames: ['status'] as const,
  registers: [register],
});

// Queue Metrics
export const queueJobsWaiting = new Gauge({
  name: 'minici_queue_jobs_waiting',
  help: 'Number of jobs currently waiting in the Redis queue',
  registers: [register],
});

export const queueJobsProcessing = new Gauge({
  name: 'minici_queue_jobs_processing',
  help: 'Number of jobs currently in processing state in Redis',
  registers: [register],
});

// Webhook Metrics
export const webhooksReceivedTotal = new Counter({
  name: 'minici_webhooks_received_total',
  help: 'Total number of GitHub webhook events received',
  labelNames: ['event', 'status'] as const,
  registers: [register],
});

// Scheduler Metrics
export const schedulerCyclesTotal = new Counter({
  name: 'minici_scheduler_cycles_total',
  help: 'Total scheduler execution loops completed',
  labelNames: ['status'] as const,
  registers: [register],
});

export const schedulerJobsAssignedTotal = new Counter({
  name: 'minici_scheduler_jobs_assigned_total',
  help: 'Total jobs assigned to workers by the scheduler',
  registers: [register],
});

export const schedulerCycleDuration = new Histogram({
  name: 'minici_scheduler_cycle_duration_seconds',
  help: 'Duration of scheduler execution loops in seconds',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

// Helper functions for updating gauges and recording metrics
export async function updateGauges(): Promise<void> {
  try {
    const [waiting, processing] = await Promise.all([
      getQueueLength().catch(() => 0),
      getProcessingLength().catch(() => 0),
    ]);
    queueJobsWaiting.set(waiting);
    queueJobsProcessing.set(processing);
  } catch {
    // Ignore queue lookup failures during gauge collection
  }

  try {
    const workers = await listWorkers().catch(() => []);
    const counts: Record<string, number> = { ready: 0, busy: 0, offline: 0, paused: 0 };
    for (const w of workers) {
      const current = counts[w.status];
      if (current !== undefined) {
        counts[w.status] = current + 1;
      }
    }
    for (const [status, count] of Object.entries(counts)) {
      activeWorkersGauge.set({ status }, count);
    }
  } catch {
    // Ignore db lookup failures during gauge collection
  }
}

export function recordHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  durationSeconds: number,
): void {
  const normRoute = route || '/';
  const statusStr = String(statusCode);
  httpRequestsTotal.inc({ method: method.toUpperCase(), route: normRoute, status_code: statusStr });
  httpRequestDuration.observe(
    { method: method.toUpperCase(), route: normRoute, status_code: statusStr },
    durationSeconds,
  );
}

export function recordWorkflowStatus(status: string, triggerEvent?: string, durationSeconds?: number): void {
  workflowsTotal.inc({ status, trigger_event: triggerEvent ?? 'manual' });
  if (durationSeconds !== undefined && durationSeconds >= 0) {
    workflowDuration.observe({ status }, durationSeconds);
  }
}

export function recordJobStatus(status: string, durationSeconds?: number): void {
  jobsTotal.inc({ status });
  if (durationSeconds !== undefined && durationSeconds >= 0) {
    jobDuration.observe({ status }, durationSeconds);
  }
}

export function recordWorkerRegistration(): void {
  workersRegisteredTotal.inc();
}

export function recordWorkerHeartbeat(status: string): void {
  workerHeartbeatsTotal.inc({ status });
}

export function recordWebhook(event: string, status: string): void {
  webhooksReceivedTotal.inc({ event, status });
}

export function recordSchedulerCycle(assignedCount: number, durationSeconds: number, status: string = 'success'): void {
  schedulerCyclesTotal.inc({ status });
  if (assignedCount > 0) {
    schedulerJobsAssignedTotal.inc(assignedCount);
  }
  schedulerCycleDuration.observe(durationSeconds);
}

export async function getMetricsText(): Promise<string> {
  await updateGauges();
  return register.metrics();
}

export function resetMetrics(): void {
  register.resetMetrics();
}
