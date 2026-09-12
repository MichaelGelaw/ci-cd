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

  it('parses a valid multi-job workflow with dependencies and shorthands', () => {
    const yaml = `
name: pipeline
image: default-runner:latest
jobs:
  build:
    name: Build Application
    image: node:20-alpine
    run: npm run build
    artifacts:
      paths:
        - dist/**
  lint:
    run: npm run lint
  test:
    needs: build
    steps:
      - run: npm test
  deploy:
    needs: [test, lint]
    run: ./deploy.sh
`;
    const result = parseWorkflow(yaml);

    expect(result.name).toBe('pipeline');
    expect(result.image).toBe('default-runner:latest');
    expect(result.jobs).toBeDefined();

    const jobs = result.jobs!;
    expect(Object.keys(jobs)).toEqual(['build', 'lint', 'test', 'deploy']);

    // build job
    expect(jobs.build?.name).toBe('Build Application');
    expect(jobs.build?.image).toBe('node:20-alpine');
    expect(jobs.build?.steps).toHaveLength(1);
    expect(jobs.build?.steps[0]?.run).toBe('npm run build');
    expect(jobs.build?.needs).toEqual([]);
    expect(jobs.build?.artifacts).toEqual({ paths: ['dist/**'] });

    // lint job
    expect(jobs.lint?.name).toBe('lint');
    expect(jobs.lint?.image).toBe('default-runner:latest');
    expect(jobs.lint?.steps[0]?.run).toBe('npm run lint');
    expect(jobs.lint?.needs).toEqual([]);

    // test job (needs string normalized to array)
    expect(jobs.test?.needs).toEqual(['build']);

    // deploy job (needs array)
    expect(jobs.deploy?.needs).toEqual(['test', 'lint']);
  });

  it('detects unknown job dependency', () => {
    const yaml = `
name: bad-dep
jobs:
  test:
    needs: [nonexistent]
    run: npm test
`;
    expect(() => parseWorkflow(yaml)).toThrow('depends on unknown job "nonexistent"');
  });

  it('detects self-dependency', () => {
    const yaml = `
name: self-dep
jobs:
  build:
    needs: [build]
    run: npm run build
`;
    expect(() => parseWorkflow(yaml)).toThrow('cannot depend on itself');
  });

  it('detects direct circular dependency (A -> B -> A)', () => {
    const yaml = `
name: cycle
jobs:
  a:
    needs: [b]
    run: echo a
  b:
    needs: [a]
    run: echo b
`;
    expect(() => parseWorkflow(yaml)).toThrow('Circular dependency detected');
  });

  it('detects indirect circular dependency (A -> B -> C -> A)', () => {
    const yaml = `
name: deep-cycle
jobs:
  a:
    needs: [c]
    run: echo a
  b:
    needs: [a]
    run: echo b
  c:
    needs: [b]
    run: echo c
`;
    expect(() => parseWorkflow(yaml)).toThrow('Circular dependency detected');
  });

  it('throws when neither steps nor jobs are provided', () => {
    const yaml = `
name: empty-pipeline
`;
    expect(() => parseWorkflow(yaml)).toThrow('either a "jobs" mapping or a "steps" array');
  });

  it('throws when job defines neither steps nor run', () => {
    const yaml = `
name: no-steps
jobs:
  build:
    name: Build
`;
    expect(() => parseWorkflow(yaml)).toThrow('must define either a "steps" array or a "run" command');
  });
});

