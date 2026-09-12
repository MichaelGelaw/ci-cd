import { buildServer } from '../apps/api/src/server.js';
import { runMigrations, closePool } from '../packages/db/src/index.js';
import { clearQueue, closeRedis, getQueueLength } from '../packages/queue/src/index.js';

interface BenchmarkStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalJobs: number;
  elapsedMs: number;
  latenciesMs: number[];
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  throughputPerSec: number;
}

function calculatePercentiles(latencies: number[]): {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
} {
  if (latencies.length === 0) {
    return { p50: 0, p90: 0, p95: 0, p99: 0, min: 0, max: 0 };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const getIndex = (p: number) => Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));

  return {
    p50: Math.round(sorted[getIndex(50)]! * 100) / 100,
    p90: Math.round(sorted[getIndex(90)]! * 100) / 100,
    p95: Math.round(sorted[getIndex(95)]! * 100) / 100,
    p99: Math.round(sorted[getIndex(99)]! * 100) / 100,
    min: Math.round(sorted[0]! * 100) / 100,
    max: Math.round(sorted[sorted.length - 1]! * 100) / 100,
  };
}

async function runBenchmark(options: {
  numWorkflows: number;
  concurrency: number;
  numWorkers: number;
}): Promise<BenchmarkStats> {
  const { numWorkflows, concurrency, numWorkers } = options;

  console.log('----------------------------------------------------');
  console.log('mini-ci Load Test & Performance Benchmark');
  console.log(`Workflows: ${numWorkflows} | Concurrency: ${concurrency} | Workers: ${numWorkers}`);
  console.log('----------------------------------------------------');

  await runMigrations();
  await clearQueue();

  const app = buildServer();
  await app.ready();

  try {
    // 1. Register workers
    console.log(`Registering ${numWorkers} workers...`);
    for (let i = 1; i <= numWorkers; i++) {
      await app.inject({
        method: 'POST',
        url: '/workers/register',
        payload: {
          id: `bench-worker-${i}`,
          name: `Benchmark Worker ${i}`,
          tags: ['docker', 'shell', 'linux'],
        },
      });
    }

    // 2. Submit workflows concurrently in batches
    console.log(`Submitting ${numWorkflows} workflows with concurrency ${concurrency}...`);
    const latencies: number[] = [];
    let successfulRequests = 0;
    let failedRequests = 0;
    let totalJobs = 0;

    const startTime = process.hrtime();

    const workflowPayloads = Array.from({ length: numWorkflows }, (_, index) => ({
      yaml: `
name: bench-workflow-${index + 1}
steps:
  - name: lint
    run: echo "linting code"
  - name: test
    run: echo "running tests"
  - name: build
    run: echo "building application"
`,
    }));

    // Chunk workflow submissions by concurrency level
    for (let i = 0; i < workflowPayloads.length; i += concurrency) {
      const chunk = workflowPayloads.slice(i, i + concurrency);
      const promises = chunk.map(async (payload) => {
        const reqStart = process.hrtime();
        try {
          const res = await app.inject({
            method: 'POST',
            url: '/workflows/runs',
            payload,
          });
          const reqDiff = process.hrtime(reqStart);
          const latencyMs = reqDiff[0] * 1000 + reqDiff[1] / 1e6;
          latencies.push(latencyMs);

          if (res.statusCode === 201) {
            successfulRequests++;
            const body = res.json();
            totalJobs += body.jobs?.length ?? 0;
          } else {
            failedRequests++;
          }
        } catch {
          failedRequests++;
        }
      });
      await Promise.all(promises);
    }

    const totalDiff = process.hrtime(startTime);
    const elapsedMs = totalDiff[0] * 1000 + totalDiff[1] / 1e6;
    const throughputPerSec = Math.round((successfulRequests / (elapsedMs / 1000)) * 100) / 100;

    // 3. Trigger scheduler rounds to measure scheduling throughput
    console.log('Triggering scheduler under backlog...');
    const schedStart = process.hrtime();
    const tickRes = await app.inject({
      method: 'POST',
      url: '/scheduler/tick',
    });
    const schedDiff = process.hrtime(schedStart);
    const schedLatencyMs = Math.round((schedDiff[0] * 1000 + schedDiff[1] / 1e6) * 100) / 100;
    const scheduledCount = tickRes.json()?.scheduled?.length ?? 0;

    console.log(`Scheduler assigned ${scheduledCount} jobs in ${schedLatencyMs}ms`);

    // 4. Fetch Prometheus metrics snapshot
    const metricsRes = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    const queueDepth = await getQueueLength();

    const percentiles = calculatePercentiles(latencies);

    const stats: BenchmarkStats = {
      totalRequests: numWorkflows,
      successfulRequests,
      failedRequests,
      totalJobs,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      latenciesMs: latencies,
      p50Ms: percentiles.p50,
      p90Ms: percentiles.p90,
      p95Ms: percentiles.p95,
      p99Ms: percentiles.p99,
      minMs: percentiles.min,
      maxMs: percentiles.max,
      throughputPerSec,
    };

    // Print benchmark report
    console.log('\n====================================================');
    console.log('BENCHMARK RESULTS');
    console.log('====================================================');
    console.log(`Total Workflows Submitted : ${stats.totalRequests}`);
    console.log(`Successful Runs           : ${stats.successfulRequests}`);
    console.log(`Failed Runs               : ${stats.failedRequests}`);
    console.log(`Total Jobs Generated      : ${stats.totalJobs}`);
    console.log(`Total Elapsed Time        : ${stats.elapsedMs} ms`);
    console.log(`Submission Throughput     : ${stats.throughputPerSec} workflows/sec (${Math.round(stats.throughputPerSec * 3 * 100) / 100} jobs/sec)`);
    console.log('----------------------------------------------------');
    console.log('LATENCY PERCENTILES (Workflow Submission)');
    console.log(`  Min                     : ${stats.minMs} ms`);
    console.log(`  P50 (Median)            : ${stats.p50Ms} ms`);
    console.log(`  P90                     : ${stats.p90Ms} ms`);
    console.log(`  P95                     : ${stats.p95Ms} ms`);
    console.log(`  P99                     : ${stats.p99Ms} ms`);
    console.log(`  Max                     : ${stats.maxMs} ms`);
    console.log('----------------------------------------------------');
    console.log(`Queue Depth (Post-Run)    : ${queueDepth}`);
    console.log(`Prometheus Metrics Size   : ${metricsRes.body.length} bytes`);
    console.log('====================================================\n');

    return stats;
  } finally {
    await clearQueue();
    await app.close();
    await closePool();
    await closeRedis();
  }
}

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(name: string, defaultValue: number): number {
  const index = args.indexOf(name);
  if (index !== -1 && args[index + 1]) {
    const val = parseInt(args[index + 1]!, 10);
    return isNaN(val) ? defaultValue : val;
  }
  return defaultValue;
}

const numWorkflows = getArg('--workflows', 50);
const concurrency = getArg('--concurrency', 10);
const numWorkers = getArg('--workers', 5);

runBenchmark({ numWorkflows, concurrency, numWorkers })
  .then((stats) => {
    if (stats.failedRequests > 0) {
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
