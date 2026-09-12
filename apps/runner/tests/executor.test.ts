import { describe, it, expect } from 'vitest';
import { executeWorkflow } from '../src/executor.js';
import type { WorkflowDefinition } from '@mini-ci/types';

describe('executeWorkflow', () => {
  it('runs a successful workflow', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test',
      steps: [
        { run: 'echo hello' },
        { run: 'echo world' },
      ],
    };

    const result = await executeWorkflow(workflow);

    expect(result.status).toBe('success');
    expect(result.workflow_name).toBe('test');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.status).toBe('success');
    expect(result.steps[1]!.status).toBe('success');
  });

  it('captures stdout', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test',
      steps: [{ run: 'echo hello' }],
    };

    const result = await executeWorkflow(workflow);
    expect(result.steps[0]!.stdout.trim()).toContain('hello');
  });

  it('captures stderr', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test',
      steps: [{ run: 'echo error_output 1>&2' }],
    };

    const result = await executeWorkflow(workflow);
    expect(result.steps[0]!.stderr.trim()).toContain('error_output');
  });

  it('captures exit codes', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test',
      steps: [{ run: 'echo hello' }],
    };

    const result = await executeWorkflow(workflow);
    expect(result.steps[0]!.exit_code).toBe(0);
  });

  it('fails on non-zero exit code', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test',
      steps: [{ run: 'exit 1' }],
    };

    const result = await executeWorkflow(workflow);
    expect(result.status).toBe('failed');
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.exit_code).toBe(1);
  });

  it('skips steps after a failure', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test',
      steps: [
        { run: 'exit 1' },
        { run: 'echo skipped' },
        { run: 'echo also skipped' },
      ],
    };

    const result = await executeWorkflow(workflow);

    expect(result.status).toBe('failed');
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[1]!.status).toBe('skipped');
    expect(result.steps[2]!.status).toBe('skipped');
  });

  it('records timing', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test',
      steps: [{ run: 'echo fast' }],
    };

    const result = await executeWorkflow(workflow);

    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.steps[0]!.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.started_at).toBeTruthy();
    expect(result.finished_at).toBeTruthy();
  });

  it('uses step name when provided', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test',
      steps: [{ name: 'greeting', run: 'echo hello' }],
    };

    const result = await executeWorkflow(workflow);
    expect(result.steps[0]!.name).toBe('greeting');
  });

  it('uses default step name when not provided', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test',
      steps: [{ run: 'echo hello' }],
    };

    const result = await executeWorkflow(workflow);
    expect(result.steps[0]!.name).toBe('Step 1');
  });

  it('kills a step that exceeds its timeout', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test',
      steps: [
        { run: 'sleep 30', timeout_seconds: 1 },
      ],
    };

    const start = Date.now();
    const result = await executeWorkflow(workflow);
    const elapsed = Date.now() - start;

    expect(result.status).toBe('failed');
    expect(result.steps[0]!.status).toBe('failed');
    expect(result.steps[0]!.error).toContain('timed out');
    // Should finish well before 30 seconds (the ping duration).
    expect(elapsed).toBeLessThan(10000);
  }, 15000);

  it('handles an unknown command', async () => {
    const workflow: WorkflowDefinition = {
      name: 'test',
      steps: [{ run: 'this_command_does_not_exist_abc123' }],
    };

    const result = await executeWorkflow(workflow);
    expect(result.status).toBe('failed');
    expect(result.steps[0]!.status).toBe('failed');
  });

  it('persists workflow runs and jobs to postgresql when persist option is enabled', async () => {
    const { runMigrations, closePool, query } = await import('@mini-ci/db');
    await runMigrations();

    const workflow: WorkflowDefinition = {
      name: 'persistent-workflow-test',
      steps: [
        { name: 'step-1', run: 'echo "hello postgres"' },
        { name: 'step-2', run: 'echo "second step"' },
      ],
    };

    const result = await executeWorkflow(workflow, { persist: true });
    expect(result.status).toBe('success');

    const { rows: runRows } = await query<{ id: string; status: string }>(
      'SELECT id, status FROM workflow_runs WHERE workflow_name = $1 ORDER BY created_at DESC LIMIT 1;',
      ['persistent-workflow-test'],
    );
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.status).toBe('succeeded');

    const runId = runRows[0]!.id;
    const { rows: jobRows } = await query<{ name: string; status: string; exit_code: number }>(
      'SELECT name, status, exit_code FROM jobs WHERE workflow_run_id = $1 ORDER BY created_at ASC;',
      [runId],
    );
    expect(jobRows).toHaveLength(2);
    expect(jobRows[0]?.name).toBe('step-1');
    expect(jobRows[0]?.status).toBe('succeeded');
    expect(jobRows[0]?.exit_code).toBe(0);

    expect(jobRows[1]?.name).toBe('step-2');
    expect(jobRows[1]?.status).toBe('succeeded');
    expect(jobRows[1]?.exit_code).toBe(0);

    await closePool();
  });
});
