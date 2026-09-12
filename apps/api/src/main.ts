import { runMigrations, closePool } from '@mini-ci/db';
import { closeRedis } from '@mini-ci/queue';
import { Scheduler } from '@mini-ci/scheduler';
import { recoverStaleJobsService, dispatchDueRetries } from './services/job-service.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 3000);
  const host = process.env['HOST'] ?? '0.0.0.0';

  console.log('Running database migrations...');
  await runMigrations();

  const logLevel = process.env['LOG_LEVEL'] ?? 'info';
  const app = buildServer({
    logger:
      logLevel === 'silent'
        ? false
        : {
            level: logLevel,
            serializers: {
              req(req) {
                return {
                  method: req.method,
                  url: req.url,
                  reqId: req.id,
                };
              },
            },
          },
  });

  const autoScheduler = process.env['ENABLE_AUTO_SCHEDULER'] !== 'false';
  let schedulerTimer: NodeJS.Timeout | null = null;

  if (autoScheduler) {
    const intervalMs = Number(process.env['SCHEDULER_INTERVAL_MS'] ?? 1000);
    const scheduler = new Scheduler();
    schedulerTimer = setInterval(async () => {
      try {
        await recoverStaleJobsService();
        await dispatchDueRetries();
        await scheduler.scheduleRound();
      } catch {
        // Ignore background scheduler errors
      }
    }, intervalMs);
    console.log(`Automatic scheduler active (tick interval: ${intervalMs}ms)`);
  }

  const stop = async (): Promise<void> => {
    console.log('Shutting down API server...');
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
    await app.close();
    await closePool();
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    const address = await app.listen({ port, host });
    console.log(`API server listening on ${address}`);
  } catch (err) {
    console.error(`Failed to start API server: ${(err as Error).message}`);
    await closePool();
    await closeRedis();
    process.exit(1);
  }
}

main();
