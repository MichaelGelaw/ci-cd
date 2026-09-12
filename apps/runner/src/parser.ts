import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import type { WorkflowDefinition, StepDefinition } from '@mini-ci/types';

export function parseWorkflowFile(filePath: string): WorkflowDefinition {
  const raw = readFileSync(filePath, 'utf-8');
  return parseWorkflow(raw);
}

export function parseWorkflow(content: string): WorkflowDefinition {
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
