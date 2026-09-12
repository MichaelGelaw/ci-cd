import { parse as parseYaml } from 'yaml';
import type { WorkflowDefinition, StepDefinition } from '@mini-ci/types';

export function parseWorkflowContent(content: string): WorkflowDefinition {
  const doc = parseYaml(content) as unknown;

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Workflow file must contain a YAML mapping');
  }

  const obj = doc as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || obj['name'].trim() === '') {
    throw new Error('Workflow must have a non-empty "name" field');
  }

  if (!Array.isArray(obj['steps'])) {
    throw new Error('Workflow must have a "steps" array');
  }

  if (obj['steps'].length === 0) {
    throw new Error('Workflow "steps" array must not be empty');
  }

  if (obj['image'] !== undefined) {
    if (typeof obj['image'] !== 'string' || obj['image'].trim() === '') {
      throw new Error('Workflow "image" must be a non-empty string');
    }
  }

  const steps: StepDefinition[] = obj['steps'].map((step: unknown, i: number) => {
    if (step === null || typeof step !== 'object') {
      throw new Error(`Step ${i + 1} must be a YAML mapping`);
    }

    const s = step as Record<string, unknown>;

    if (typeof s['run'] !== 'string' || s['run'].trim() === '') {
      throw new Error(`Step ${i + 1} must have a non-empty "run" field`);
    }

    const def: StepDefinition = { run: s['run'] };

    if (s['name'] !== undefined) {
      if (typeof s['name'] !== 'string') {
        throw new Error(`Step ${i + 1} "name" must be a string`);
      }
      def.name = s['name'];
    }

    if (s['image'] !== undefined) {
      if (typeof s['image'] !== 'string' || s['image'].trim() === '') {
        throw new Error(`Step ${i + 1} "image" must be a non-empty string`);
      }
      def.image = s['image'];
    }

    if (s['timeout_seconds'] !== undefined) {
      if (typeof s['timeout_seconds'] !== 'number' || s['timeout_seconds'] <= 0) {
        throw new Error(`Step ${i + 1} "timeout_seconds" must be a positive number`);
      }
      def.timeout_seconds = s['timeout_seconds'];
    }

    if (s['retries'] !== undefined) {
      if (typeof s['retries'] !== 'number' || !Number.isInteger(s['retries']) || s['retries'] < 0) {
        throw new Error(`Step ${i + 1} "retries" must be a non-negative integer`);
      }
      def.retries = s['retries'];
    }

    if (s['retry'] !== undefined) {
      if (typeof s['retry'] !== 'object' || s['retry'] === null || Array.isArray(s['retry'])) {
        throw new Error(`Step ${i + 1} "retry" must be a mapping`);
      }
      const r = s['retry'] as Record<string, unknown>;
      def.retry = {};

      if (r['max_attempts'] !== undefined) {
        if (typeof r['max_attempts'] !== 'number' || !Number.isInteger(r['max_attempts']) || r['max_attempts'] < 1) {
          throw new Error(`Step ${i + 1} retry "max_attempts" must be an integer >= 1`);
        }
        def.retry.max_attempts = r['max_attempts'];
      }
      if (r['base_delay_seconds'] !== undefined) {
        if (typeof r['base_delay_seconds'] !== 'number' || r['base_delay_seconds'] <= 0) {
          throw new Error(`Step ${i + 1} retry "base_delay_seconds" must be a positive number`);
        }
        def.retry.base_delay_seconds = r['base_delay_seconds'];
      }
      if (r['max_delay_seconds'] !== undefined) {
        if (typeof r['max_delay_seconds'] !== 'number' || r['max_delay_seconds'] <= 0) {
          throw new Error(`Step ${i + 1} retry "max_delay_seconds" must be a positive number`);
        }
        def.retry.max_delay_seconds = r['max_delay_seconds'];
      }
      if (r['backoff_factor'] !== undefined) {
        if (typeof r['backoff_factor'] !== 'number' || r['backoff_factor'] < 1) {
          throw new Error(`Step ${i + 1} retry "backoff_factor" must be a number >= 1`);
        }
        def.retry.backoff_factor = r['backoff_factor'];
      }
      if (r['jitter'] !== undefined) {
        if (typeof r['jitter'] !== 'boolean') {
          throw new Error(`Step ${i + 1} retry "jitter" must be a boolean`);
        }
        def.retry.jitter = r['jitter'];
      }
      if (r['retry_on_timeout'] !== undefined) {
        if (typeof r['retry_on_timeout'] !== 'boolean') {
          throw new Error(`Step ${i + 1} retry "retry_on_timeout" must be a boolean`);
        }
        def.retry.retry_on_timeout = r['retry_on_timeout'];
      }
    }

    return def;
  });

  const workflow: WorkflowDefinition = {
    name: obj['name'],
    steps,
  };

  if (obj['image'] !== undefined) {
    workflow.image = obj['image'] as string;
  }

  return workflow;
}
