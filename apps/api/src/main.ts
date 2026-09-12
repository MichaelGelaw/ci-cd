import { runMigrations, closePool } from '@mini-ci/db';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 3000);
  const host = process.env['HOST'] ?? '0.0.0.0';

  console.log('Running database migrations...');
  await runMigrations();

  const app = buildServer({
    logger: false,
  });

  const stop = async (): Promise<void> => {
    console.log('Shutting down API server...');
    await app.close();
    await closePool();
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
    process.exit(1);
  }
}

main();
