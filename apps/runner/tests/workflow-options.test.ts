import { describe, expect, it } from 'vitest';
import { executeWorkflow } from '../src/executor.js';

describe('workflow execution options', () => {
  it('passes workflow and job environment variables to shell commands', async () => {
    const result = await executeWorkflow({
      name: 'env', env: { VALUE: 'workflow' },
      jobs: { build: { env: { VALUE: 'job' }, run: 'printf %s "$VALUE"' } },
    });
    expect(result.status).toBe('success');
    expect(result.steps[0]?.stdout).toBe('job');
  });

  it('passes environment values without evaluating shell substitutions', async () => {
    const result = await executeWorkflow({
      name: 'env', env: { VALUE: '$(echo injected)' }, steps: [{ run: 'printf %s "$VALUE"' }],
    });
    expect(result.steps[0]?.stdout).toBe('$(echo injected)');
  });

  it('honors retry_on_timeout=false', async () => {
    const result = await executeWorkflow({
      name: 'timeout',
      steps: [{ run: 'sleep 2', timeout_seconds: 0.05, retry: { max_attempts: 3, retry_on_timeout: false } }],
    });
    expect(result.status).toBe('failed');
    expect(result.duration_ms).toBeLessThan(1000);
  });
});
