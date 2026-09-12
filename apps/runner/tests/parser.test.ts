import { describe, it, expect } from 'vitest';
import { parseWorkflow } from '../src/parser.js';

describe('parseWorkflow', () => {
  it('parses a valid workflow', () => {
    const yaml = `
name: test
steps:
  - run: echo hello
  - name: greet
    run: echo world
`;
    const result = parseWorkflow(yaml);

    expect(result.name).toBe('test');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.run).toBe('echo hello');
    expect(result.steps[0]!.name).toBeUndefined();
    expect(result.steps[1]!.run).toBe('echo world');
    expect(result.steps[1]!.name).toBe('greet');
  });

  it('parses timeout_seconds', () => {
    const yaml = `
name: test
steps:
  - run: sleep 10
    timeout_seconds: 5
`;
    const result = parseWorkflow(yaml);
    expect(result.steps[0]!.timeout_seconds).toBe(5);
  });

  it('throws when name is missing', () => {
    const yaml = `
steps:
  - run: echo hello
`;
    expect(() => parseWorkflow(yaml)).toThrow('non-empty "name"');
  });

  it('throws when name is empty', () => {
    const yaml = `
name: ""
steps:
  - run: echo hello
`;
    expect(() => parseWorkflow(yaml)).toThrow('non-empty "name"');
  });

  it('throws when steps is missing', () => {
    const yaml = `
name: test
`;
    expect(() => parseWorkflow(yaml)).toThrow('"steps" array');
  });

  it('throws when steps is empty', () => {
    const yaml = `
name: test
steps: []
`;
    expect(() => parseWorkflow(yaml)).toThrow('must not be empty');
  });

  it('throws when a step has no run field', () => {
    const yaml = `
name: test
steps:
  - name: bad step
`;
    expect(() => parseWorkflow(yaml)).toThrow('Step 1 must have a non-empty "run"');
  });

  it('throws when a step has an empty run field', () => {
    const yaml = `
name: test
steps:
  - run: ""
`;
    expect(() => parseWorkflow(yaml)).toThrow('non-empty "run"');
  });

  it('throws when timeout_seconds is not positive', () => {
    const yaml = `
name: test
steps:
  - run: echo hello
    timeout_seconds: -1
`;
    expect(() => parseWorkflow(yaml)).toThrow('positive number');
  });

  it('throws when the document is not a mapping', () => {
    const yaml = `- just a list`;
    expect(() => parseWorkflow(yaml)).toThrow('YAML mapping');
  });

  it('parses retries and retry policy mapping', () => {
    const yaml = `
name: retry-test
steps:
  - run: ./flaky.sh
    retries: 2
  - run: ./flaky-policy.sh
    retry:
      max_attempts: 4
      base_delay_seconds: 1.5
      max_delay_seconds: 10
      backoff_factor: 2
      jitter: false
      retry_on_timeout: true
`;
    const result = parseWorkflow(yaml);
    expect(result.steps[0]!.retries).toBe(2);
    expect(result.steps[1]!.retry).toEqual({
      max_attempts: 4,
      base_delay_seconds: 1.5,
      max_delay_seconds: 10,
      backoff_factor: 2,
      jitter: false,
      retry_on_timeout: true,
    });
  });

  it('throws on invalid retry configurations', () => {
    expect(() =>
      parseWorkflow(`
name: bad
steps:
  - run: echo 1
    retries: -1
`),
    ).toThrow('non-negative integer');

    expect(() =>
      parseWorkflow(`
name: bad
steps:
  - run: echo 1
    retry: "not-a-map"
`),
    ).toThrow('must be a mapping');

    expect(() =>
      parseWorkflow(`
name: bad
steps:
  - run: echo 1
    retry:
      max_attempts: 0
`),
    ).toThrow('max_attempts');
  });
});

