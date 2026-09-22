import { describe, expect, it } from 'vitest';
import { parseWorkflow } from '../../runner/src/parser.js';
import { matchPattern, normalizeWorkflow, parseWorkflowContent } from '../src/services/workflow-parser.js';

for (const [name, parse] of [['runner', parseWorkflow], ['api', parseWorkflowContent]] as const) {
  describe(`${name} workflow validation`, () => {
    it.each(['.nan', '.inf', '-.inf'])('rejects non-finite timeouts: %s', (timeout) => {
      expect(() => parse(`name: invalid\nsteps:\n  - run: echo hi\n    timeout_seconds: ${timeout}`))
        .toThrow('positive number');
    });

    it('keeps prototype-sensitive job names in the execution graph', () => {
      const workflow = parse('name: keys\njobs:\n  constructor:\n    run: echo first\n  __proto__:\n    needs: constructor\n    run: echo second');
      expect(normalizeWorkflow(workflow).topologicalOrder).toEqual(['constructor', '__proto__']);
      expect(Object.keys(workflow.jobs!)).toEqual(['constructor', '__proto__']);
    });

    it('rejects inherited property names as missing dependencies', () => {
      expect(() => parse('name: keys\njobs:\n  build:\n    needs: toString\n    run: echo hi'))
        .toThrow('unknown job');
    });

    it('validates environment variable names and normalizes scalar values', () => {
      expect(() => parse('name: env\nenv:\n  "X; touch injected": value\nsteps:\n  - run: echo hi'))
        .toThrow('Invalid environment variable name');
      expect(parse('name: env\nenv:\n  PORT: 3000\n  CI: true\nsteps:\n  - run: echo hi').env)
        .toEqual({ PORT: '3000', CI: 'true' });
    });
  });
}

it('matches recursive branch globs without rewriting generated regex wildcards', () => {
  expect(matchPattern('release/**', 'release/team/version')).toBe(true);
  expect(matchPattern('release/*', 'release/team/version')).toBe(false);
  expect(matchPattern('release/**', 'feature/team/version')).toBe(false);
});
