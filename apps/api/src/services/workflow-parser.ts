import { parse as parseYaml } from 'yaml';
import type {
  WorkflowDefinition,
  StepDefinition,
  JobDefinition,
  RetryPolicy,
  ArtifactConfig,
  NormalizedWorkflowDefinition,
  NormalizedJobDefinition,
  WorkflowTriggerConfig,
  EventTriggerFilter,
} from '@mini-ci/types';

function parseEnvironment(raw: object): Record<string, string> {
  const env: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name "${key}"`);
    }
    if (typeof value !== 'string' && typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`Environment variable "${key}" must have a scalar value`);
    }
    if (String(value).includes('\0')) {
      throw new Error(`Environment variable "${key}" must not contain a null byte`);
    }
    env[key] = String(value);
  }
  return env;
}

export function parseStep(
  step: unknown,
  i: number,
  contextPrefix: string = 'Step',
): StepDefinition {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) {
    throw new Error(`${contextPrefix} ${i + 1} must be a YAML mapping`);
  }

  const s = step as Record<string, unknown>;

  if (typeof s['run'] !== 'string' || s['run'].trim() === '') {
    throw new Error(`${contextPrefix} ${i + 1} must have a non-empty "run" field`);
  }

  const def: StepDefinition = { run: s['run'] };

  if (s['name'] !== undefined) {
    if (typeof s['name'] !== 'string') {
      throw new Error(`${contextPrefix} ${i + 1} "name" must be a string`);
    }
    def.name = s['name'];
  }

  if (s['image'] !== undefined) {
    if (typeof s['image'] !== 'string' || s['image'].trim() === '') {
      throw new Error(`${contextPrefix} ${i + 1} "image" must be a non-empty string`);
    }
    def.image = s['image'];
  }

  if (s['timeout_seconds'] !== undefined) {
    if (typeof s['timeout_seconds'] !== 'number' || !Number.isFinite(s['timeout_seconds']) || s['timeout_seconds'] <= 0) {
      throw new Error(`${contextPrefix} ${i + 1} "timeout_seconds" must be a positive number`);
    }
    def.timeout_seconds = s['timeout_seconds'];
  }

  if (s['retries'] !== undefined) {
    if (typeof s['retries'] !== 'number' || !Number.isInteger(s['retries']) || s['retries'] < 0) {
      throw new Error(`${contextPrefix} ${i + 1} "retries" must be a non-negative integer`);
    }
    def.retries = s['retries'];
  }

  if (s['retry'] !== undefined) {
    def.retry = parseRetryPolicy(s['retry'], `${contextPrefix} ${i + 1}`);
  }

  if (s['artifacts'] !== undefined) {
    def.artifacts = parseArtifacts(s['artifacts'], `${contextPrefix} ${i + 1}`);
  }

  return def;
}

function parseRetryPolicy(retry: unknown, prefix: string): RetryPolicy {
  if (typeof retry !== 'object' || retry === null || Array.isArray(retry)) {
    throw new Error(`${prefix} "retry" must be a mapping`);
  }
  const r = retry as Record<string, unknown>;
  const policy: RetryPolicy = {};

  if (r['max_attempts'] !== undefined) {
    if (typeof r['max_attempts'] !== 'number' || !Number.isInteger(r['max_attempts']) || r['max_attempts'] < 1) {
      throw new Error(`${prefix} retry "max_attempts" must be an integer >= 1`);
    }
    policy.max_attempts = r['max_attempts'];
  }
  if (r['base_delay_seconds'] !== undefined) {
    if (typeof r['base_delay_seconds'] !== 'number' || !Number.isFinite(r['base_delay_seconds']) || r['base_delay_seconds'] <= 0) {
      throw new Error(`${prefix} retry "base_delay_seconds" must be a positive number`);
    }
    policy.base_delay_seconds = r['base_delay_seconds'];
  }
  if (r['max_delay_seconds'] !== undefined) {
    if (typeof r['max_delay_seconds'] !== 'number' || !Number.isFinite(r['max_delay_seconds']) || r['max_delay_seconds'] <= 0) {
      throw new Error(`${prefix} retry "max_delay_seconds" must be a positive number`);
    }
    policy.max_delay_seconds = r['max_delay_seconds'];
  }
  if (r['backoff_factor'] !== undefined) {
    if (typeof r['backoff_factor'] !== 'number' || !Number.isFinite(r['backoff_factor']) || r['backoff_factor'] < 1) {
      throw new Error(`${prefix} retry "backoff_factor" must be a number >= 1`);
    }
    policy.backoff_factor = r['backoff_factor'];
  }
  if (r['jitter'] !== undefined) {
    if (typeof r['jitter'] !== 'boolean') {
      throw new Error(`${prefix} retry "jitter" must be a boolean`);
    }
    policy.jitter = r['jitter'];
  }
  if (r['retry_on_timeout'] !== undefined) {
    if (typeof r['retry_on_timeout'] !== 'boolean') {
      throw new Error(`${prefix} retry "retry_on_timeout" must be a boolean`);
    }
    policy.retry_on_timeout = r['retry_on_timeout'];
  }

  return policy;
}

function parseArtifacts(artifacts: unknown, prefix: string): string[] | ArtifactConfig {
  if (Array.isArray(artifacts)) {
    return artifacts.map((item, idx) => {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new Error(`${prefix} artifact item ${idx + 1} must be a non-empty string`);
      }
      return item;
    });
  }
  if (typeof artifacts === 'string' && artifacts.trim() !== '') {
    return [artifacts];
  }
  if (typeof artifacts === 'object' && artifacts !== null) {
    const a = artifacts as Record<string, unknown>;
    const config: ArtifactConfig = {};
    if (a['name'] !== undefined) {
      if (typeof a['name'] !== 'string') {
        throw new Error(`${prefix} artifact "name" must be a string`);
      }
      config.name = a['name'];
    }
    if (a['path'] !== undefined) {
      if (typeof a['path'] !== 'string') {
        throw new Error(`${prefix} artifact "path" must be a string`);
      }
      config.path = a['path'];
    }
    if (a['paths'] !== undefined) {
      if (!Array.isArray(a['paths'])) {
        throw new Error(`${prefix} artifact "paths" must be an array`);
      }
      config.paths = a['paths'].map((p) => String(p));
    }
    if (a['retention_days'] !== undefined) {
      if (typeof a['retention_days'] !== 'number' || !Number.isFinite(a['retention_days']) || a['retention_days'] <= 0) {
        throw new Error(`${prefix} artifact "retention_days" must be a positive number`);
      }
      config.retention_days = a['retention_days'];
    }
    return config;
  }
  throw new Error(`${prefix} "artifacts" must be a list of paths or an artifact configuration mapping`);
}

export function parseJob(
  key: string,
  raw: unknown,
  defaultImage?: string,
): JobDefinition {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Job "${key}" must be a YAML mapping`);
  }

  const j = raw as Record<string, unknown>;
  const job: JobDefinition = {};

  if (j['name'] !== undefined) {
    if (typeof j['name'] !== 'string' || j['name'].trim() === '') {
      throw new Error(`Job "${key}" "name" must be a non-empty string`);
    }
    job.name = j['name'];
  } else {
    job.name = key;
  }

  if (j['image'] !== undefined) {
    if (typeof j['image'] !== 'string' || j['image'].trim() === '') {
      throw new Error(`Job "${key}" "image" must be a non-empty string`);
    }
    job.image = j['image'];
  } else if (defaultImage) {
    job.image = defaultImage;
  }

  if (j['needs'] !== undefined) {
    if (Array.isArray(j['needs'])) {
      job.needs = j['needs'].map((dep, idx) => {
        if (typeof dep !== 'string' || dep.trim() === '') {
          throw new Error(`Job "${key}" "needs" entry ${idx + 1} must be a non-empty string`);
        }
        return dep;
      });
    } else if (typeof j['needs'] === 'string' && j['needs'].trim() !== '') {
      job.needs = [j['needs']];
    } else {
      throw new Error(`Job "${key}" "needs" must be a string or array of strings`);
    }
  } else {
    job.needs = [];
  }

  if (j['timeout_seconds'] !== undefined) {
    if (typeof j['timeout_seconds'] !== 'number' || !Number.isFinite(j['timeout_seconds']) || j['timeout_seconds'] <= 0) {
      throw new Error(`Job "${key}" "timeout_seconds" must be a positive number`);
    }
    job.timeout_seconds = j['timeout_seconds'];
  }

  if (j['retries'] !== undefined) {
    if (typeof j['retries'] !== 'number' || !Number.isInteger(j['retries']) || j['retries'] < 0) {
      throw new Error(`Job "${key}" "retries" must be a non-negative integer`);
    }
    job.retries = j['retries'];
  }

  if (j['retry'] !== undefined) {
    job.retry = parseRetryPolicy(j['retry'], `Job "${key}"`);
  }

  if (j['artifacts'] !== undefined) {
    job.artifacts = parseArtifacts(j['artifacts'], `Job "${key}"`);
  }

  if (j['priority'] !== undefined) {
    if (typeof j['priority'] !== 'number' || !Number.isInteger(j['priority'])) {
      throw new Error(`Job "${key}" "priority" must be an integer`);
    }
    job.priority = j['priority'];
  }

  if (j['tags'] !== undefined) {
    if (!Array.isArray(j['tags'])) {
      throw new Error(`Job "${key}" "tags" must be an array of strings`);
    }
    job.tags = j['tags'].map((t) => String(t));
  }

  if (j['env'] !== undefined) {
    if (typeof j['env'] !== 'object' || j['env'] === null || Array.isArray(j['env'])) {
      throw new Error(`Job "${key}" "env" must be a mapping`);
    }
    job.env = parseEnvironment(j['env']);
  }

  if (Array.isArray(j['steps'])) {
    if (j['steps'].length === 0) {
      throw new Error(`Job "${key}" "steps" array must not be empty`);
    }
    job.steps = j['steps'].map((step, idx) => parseStep(step, idx, `Job "${key}" step`));
  } else if (typeof j['run'] === 'string') {
    if (j['run'].trim() === '') {
      throw new Error(`Job "${key}" "run" must not be empty`);
    }
    job.run = j['run'];
    job.steps = [
      {
        name: job.name,
        run: j['run'],
        image: job.image,
        timeout_seconds: job.timeout_seconds,
        retries: job.retries,
        retry: job.retry,
        artifacts: job.artifacts,
      },
    ];
  } else {
    throw new Error(`Job "${key}" must define either a "steps" array or a "run" command`);
  }

  return job;
}

export function validateJobDependencies(jobs: Record<string, JobDefinition>): string[] {
  const jobKeys = Object.keys(jobs);

  for (const [key, job] of Object.entries(jobs)) {
    const needs = Array.isArray(job.needs)
      ? job.needs
      : typeof job.needs === 'string'
        ? [job.needs]
        : [];
    for (const dep of needs) {
      if (dep === key) {
        throw new Error(`Job "${key}" cannot depend on itself`);
      }
      if (!Object.hasOwn(jobs, dep)) {
        throw new Error(`Job "${key}" depends on unknown job "${dep}"`);
      }
    }
  }

  const visited: Record<string, number> = Object.create(null);
  const order: string[] = [];
  const currentPath: string[] = [];

  function dfs(node: string) {
    visited[node] = 1;
    currentPath.push(node);

    const job = jobs[node]!;
    const needs = Array.isArray(job.needs)
      ? job.needs
      : typeof job.needs === 'string'
        ? [job.needs]
        : [];

    for (const dep of needs) {
      if (visited[dep] === 1) {
        const cycleStartIndex = currentPath.indexOf(dep);
        const cycle = [...currentPath.slice(cycleStartIndex), dep];
        throw new Error(`Circular dependency detected in jobs: ${cycle.join(' -> ')}`);
      }
      if (!visited[dep]) {
        dfs(dep);
      }
    }

    currentPath.pop();
    visited[node] = 2;
    order.push(node);
  }

  for (const key of jobKeys) {
    if (!visited[key]) {
      dfs(key);
    }
  }

  return order;
}

export function normalizeWorkflow(workflow: WorkflowDefinition): NormalizedWorkflowDefinition {
  if (workflow.jobs && Object.keys(workflow.jobs).length > 0) {
    const topologicalOrder = validateJobDependencies(workflow.jobs);
    const normalizedJobs: Record<string, NormalizedJobDefinition> = Object.create(null);

    for (const key of Object.keys(workflow.jobs)) {
      const job = workflow.jobs[key]!;
      const needs = Array.isArray(job.needs)
        ? job.needs
        : typeof job.needs === 'string'
          ? [job.needs]
          : [];

      normalizedJobs[key] = {
        id: key,
        name: job.name ?? key,
        image: job.image ?? workflow.image,
        steps: job.steps ?? (job.run ? [{ run: job.run }] : []),
        needs,
        timeout_seconds: job.timeout_seconds,
        retries: job.retries,
        retry: job.retry,
        artifacts: job.artifacts,
        priority: job.priority,
        tags: job.tags,
        env: { ...workflow.env, ...job.env },
      };
    }

    return {
      name: workflow.name,
      on: workflow.on,
      image: workflow.image,
      jobs: normalizedJobs,
      topologicalOrder,
      env: workflow.env,
    };
  }

  if (workflow.steps && workflow.steps.length > 0) {
    return {
      name: workflow.name,
      on: workflow.on,
      image: workflow.image,
      jobs: {
        main: {
          id: 'main',
          name: workflow.name,
          image: workflow.image,
          steps: workflow.steps,
          needs: [],
          env: workflow.env,
        },
      },
      topologicalOrder: ['main'],
      env: workflow.env,
    };
  }

  throw new Error('Workflow must have either a "jobs" mapping or a "steps" array');
}

export function parseWorkflowContent(content: string): WorkflowDefinition {
  const doc = parseYaml(content) as unknown;

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Workflow file must contain a YAML mapping');
  }

  const obj = doc as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || obj['name'].trim() === '') {
    throw new Error('Workflow must have a non-empty "name" field');
  }

  const workflow: WorkflowDefinition = {
    name: obj['name'],
  };

  if (obj['image'] !== undefined) {
    if (typeof obj['image'] !== 'string' || obj['image'].trim() === '') {
      throw new Error('Workflow "image" must be a non-empty string');
    }
    workflow.image = obj['image'];
  }

  if (obj['env'] !== undefined) {
    if (typeof obj['env'] !== 'object' || obj['env'] === null || Array.isArray(obj['env'])) {
      throw new Error('Workflow "env" must be a mapping');
    }
    workflow.env = parseEnvironment(obj['env']);
  }

  if (obj['on'] !== undefined) {
    workflow.on = parseWorkflowTrigger(obj['on']);
  }

  const hasJobs = obj['jobs'] !== undefined;
  const hasSteps = obj['steps'] !== undefined;

  if (!hasJobs && !hasSteps) {
    throw new Error('Workflow must have either a "jobs" mapping or a "steps" array');
  }

  if (hasJobs) {
    if (typeof obj['jobs'] !== 'object' || obj['jobs'] === null || Array.isArray(obj['jobs'])) {
      throw new Error('Workflow "jobs" must be a mapping');
    }
    const rawJobs = obj['jobs'] as Record<string, unknown>;
    const jobKeys = Object.keys(rawJobs);
    if (jobKeys.length === 0) {
      throw new Error('Workflow "jobs" mapping must not be empty');
    }

    const jobs: Record<string, JobDefinition> = Object.create(null);
    for (const key of jobKeys) {
      jobs[key] = parseJob(key, rawJobs[key], workflow.image);
    }

    validateJobDependencies(jobs);
    workflow.jobs = jobs;
  }

  if (hasSteps) {
    if (!Array.isArray(obj['steps'])) {
      throw new Error('Workflow must have a "steps" array');
    }
    if (obj['steps'].length === 0) {
      throw new Error('Workflow "steps" array must not be empty');
    }
    workflow.steps = obj['steps'].map((step, idx) => parseStep(step, idx));
  }

  return workflow;
}

export function parseWorkflowTrigger(raw: unknown): WorkflowTriggerConfig {
  if (typeof raw === 'string') {
    if (raw.trim() === '') {
      throw new Error('Workflow "on" trigger cannot be an empty string');
    }
    return raw.trim();
  }

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new Error('Workflow "on" trigger list cannot be empty');
    }
    return raw.map((item, idx) => {
      if (typeof item !== 'string' || item.trim() === '') {
        throw new Error(`Workflow "on" trigger list item ${idx + 1} must be a non-empty string`);
      }
      return item.trim();
    });
  }

  if (typeof raw === 'object' && raw !== null) {
    const config: Record<string, EventTriggerFilter | null> = Object.create(null);
    for (const [event, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val === null || val === undefined) {
        config[event] = null;
      } else if (typeof val === 'object' && !Array.isArray(val)) {
        const filterObj = val as Record<string, unknown>;
        const filter: EventTriggerFilter = {};
        if (filterObj['branches'] !== undefined) {
          if (Array.isArray(filterObj['branches'])) {
            filter.branches = filterObj['branches'].map(String);
          } else if (typeof filterObj['branches'] === 'string') {
            filter.branches = [filterObj['branches']];
          } else {
            throw new Error(`Workflow "on.${event}.branches" must be a string or list of strings`);
          }
        }
        if (filterObj['types'] !== undefined) {
          if (Array.isArray(filterObj['types'])) {
            filter.types = filterObj['types'].map(String);
          } else if (typeof filterObj['types'] === 'string') {
            filter.types = [filterObj['types']];
          } else {
            throw new Error(`Workflow "on.${event}.types" must be a string or list of strings`);
          }
        }
        config[event] = filter;
      } else {
        throw new Error(`Workflow "on.${event}" must be a filter mapping or empty`);
      }
    }
    return config;
  }

  throw new Error('Workflow "on" must be a string, list of strings, or mapping');
}

export function matchPattern(pattern: string, target: string): boolean {
  if (pattern === '*' || pattern === '**') {
    return true;
  }
  if (pattern.includes('*')) {
    const regexStr =
      '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*|\*/g, (wildcard) => wildcard === '**' ? '.*' : '[^/]*') +
      '$';
    const regex = new RegExp(regexStr);
    return regex.test(target);
  }
  return pattern === target;
}

export function shouldTriggerWorkflow(
  workflow: WorkflowDefinition | NormalizedWorkflowDefinition,
  event: string,
  branch?: string,
  action?: string,
): boolean {
  if (!workflow.on) {
    return true;
  }

  if (typeof workflow.on === 'string') {
    return workflow.on === event;
  }

  if (Array.isArray(workflow.on)) {
    return workflow.on.includes(event);
  }

  if (typeof workflow.on === 'object') {
    const eventConfig = (workflow.on as Record<string, EventTriggerFilter | null | undefined>)[
      event
    ];
    if (!Object.hasOwn(workflow.on, event) || eventConfig === undefined) {
      return false;
    }

    if (eventConfig === null) {
      return true;
    }

    if (eventConfig.branches && eventConfig.branches.length > 0 && branch) {
      const cleanBranch = branch.startsWith('refs/heads/') ? branch.slice(11) : branch;
      const branchMatches = eventConfig.branches.some((pattern) =>
        matchPattern(pattern, cleanBranch),
      );
      if (!branchMatches) {
        return false;
      }
    }

    if (eventConfig.types && eventConfig.types.length > 0 && action) {
      const typeMatches = eventConfig.types.includes(action);
      if (!typeMatches) {
        return false;
      }
    }

    return true;
  }

  return false;
}
