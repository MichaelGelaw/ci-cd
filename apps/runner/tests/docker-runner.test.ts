import { describe, it, expect, beforeAll } from 'vitest';
import Docker from 'dockerode';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { pullImage, runStepInDocker } from '../src/docker-runner.js';

const docker = new Docker();

// Check if Docker is available before running these tests.
async function isDockerAvailable(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

describe('docker-runner', () => {
  let dockerAvailable = false;

  beforeAll(async () => {
    dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      console.warn('Docker is not available, skipping Docker tests');
    }
  });

  it('pulls an image', async () => {
    if (!dockerAvailable) return;

    // This should not throw.
    await pullImage('alpine:latest');
  }, 30000);

  it('runs a command and captures stdout', async () => {
    if (!dockerAvailable) return;

    const workspace = await mkdtemp(join(tmpdir(), 'docker-test-'));
    try {
      const result = await runStepInDocker(
        'alpine:latest',
        'echo "hello from docker"',
        workspace,
        undefined,
      );

      expect(result.exit_code).toBe(0);
      expect(result.stdout.trim()).toBe('hello from docker');
      expect(result.error).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30000);

  it('captures stderr', async () => {
    if (!dockerAvailable) return;

    const workspace = await mkdtemp(join(tmpdir(), 'docker-test-'));
    try {
      const result = await runStepInDocker(
        'alpine:latest',
        'echo "error output" >&2',
        workspace,
        undefined,
      );

      expect(result.exit_code).toBe(0);
      expect(result.stderr.trim()).toBe('error output');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30000);

  it('captures non-zero exit codes', async () => {
    if (!dockerAvailable) return;

    const workspace = await mkdtemp(join(tmpdir(), 'docker-test-'));
    try {
      const result = await runStepInDocker(
        'alpine:latest',
        'exit 42',
        workspace,
        undefined,
      );

      expect(result.exit_code).toBe(42);
      expect(result.error).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30000);

  it('times out and kills the container', async () => {
    if (!dockerAvailable) return;

    const workspace = await mkdtemp(join(tmpdir(), 'docker-test-'));
    try {
      const start = Date.now();
      const result = await runStepInDocker(
        'alpine:latest',
        'sleep 60',
        workspace,
        2000,
      );
      const elapsed = Date.now() - start;

      expect(result.error).toContain('timed out');
      expect(elapsed).toBeLessThan(15000);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30000);

  it('shares workspace between calls', async () => {
    if (!dockerAvailable) return;

    const workspace = await mkdtemp(join(tmpdir(), 'docker-test-'));
    try {
      // Step 1: write a file to the workspace.
      const write = await runStepInDocker(
        'alpine:latest',
        'echo "shared data" > /workspace/test.txt',
        workspace,
        undefined,
      );
      expect(write.exit_code).toBe(0);

      // Step 2: read the file from the workspace.
      const read = await runStepInDocker(
        'alpine:latest',
        'cat /workspace/test.txt',
        workspace,
        undefined,
      );
      expect(read.exit_code).toBe(0);
      expect(read.stdout.trim()).toBe('shared data');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30000);

  it('cleans up containers after execution', async () => {
    if (!dockerAvailable) return;

    const workspace = await mkdtemp(join(tmpdir(), 'docker-test-'));
    const containersBefore = await docker.listContainers({ all: true });

    try {
      await runStepInDocker('alpine:latest', 'echo "cleanup test"', workspace, undefined);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }

    const containersAfter = await docker.listContainers({ all: true });
    // Should not have leaked any containers.
    expect(containersAfter.length).toBeLessThanOrEqual(containersBefore.length);
  }, 30000);

  it('reports an error for an unknown image', async () => {
    if (!dockerAvailable) return;

    const workspace = await mkdtemp(join(tmpdir(), 'docker-test-'));
    try {
      const result = await runStepInDocker(
        'this-image-does-not-exist-abc123:latest',
        'echo hello',
        workspace,
        undefined,
      );

      expect(result.error).toBeTruthy();
      expect(result.exit_code).toBeNull();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30000);
});
