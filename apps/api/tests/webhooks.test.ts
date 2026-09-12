import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import {
  runMigrations,
  closePool,
  createRepository,
  createRegisteredWorkflow,
  getRepository,
  getWorkflowRun,
  getJobsByWorkflowRun,
} from '@mini-ci/db';
import { closeRedis, clearQueue, getQueueLength, getRedisClient, QUEUE_KEY } from '@mini-ci/queue';
import { buildServer } from '../src/server.js';

function computeSignature(payload: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

describe('GitHub Webhook Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await runMigrations();
    await clearQueue();
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await clearQueue();
    await app.close();
    await closePool();
    await closeRedis();
  });

  it('handles ping event returning pong and zen message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'ping',
      },
      payload: {
        zen: 'Approachable is better than simple.',
        hook_id: 12345,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message).toBe('pong');
    expect(body.zen).toBe('Approachable is better than simple.');
  });

  it('rejects webhook with 400 when X-GitHub-Event header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      payload: {
        repository: { full_name: 'owner/repo' },
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('MISSING_HEADER');
  });

  it('rejects webhook with 401 when signature is invalid', async () => {
    const repoName = `test-org/secret-repo-${Date.now()}`;
    await createRepository({
      name: repoName,
      webhook_secret: 'correct-secret',
    });

    const payloadObj = {
      repository: { full_name: repoName },
      ref: 'refs/heads/main',
      after: 'a1b2c3d4e5',
      sender: { login: 'octocat' },
    };

    const payloadStr = JSON.stringify(payloadObj);
    const wrongSignature = computeSignature(payloadStr, 'wrong-secret');

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': wrongSignature,
        'content-type': 'application/json',
      },
      payload: payloadStr,
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('accepts push event with valid signature and triggers matching workflow run', async () => {
    const repoName = `org/push-repo-${Date.now()}`;
    const secret = 'my-webhook-secret-123';
    const repo = await createRepository({
      name: repoName,
      webhook_secret: secret,
      default_branch: 'main',
    });

    // Register a multi-job workflow for this repo that watches pushes to main
    const workflowYaml = `
name: Build and Test
on:
  push:
    branches:
      - main
      - 'release/*'
jobs:
  build:
    name: Compile
    run: echo "Building project commit $GITHUB_SHA on branch $GITHUB_BRANCH"
  test:
    name: Unit Tests
    needs: [build]
    run: echo "Running tests for $GITHUB_REPOSITORY"
`;

    await createRegisteredWorkflow({
      repositoryId: repo.id,
      name: 'ci.yml',
      content: workflowYaml,
      isActive: true,
    });

    const payloadObj = {
      ref: 'refs/heads/main',
      after: '9f8e7d6c5b4a',
      head_commit: {
        id: '9f8e7d6c5b4a',
        message: 'feat: add awesome feature',
      },
      repository: {
        full_name: repoName,
        name: repoName.split('/')[1],
        default_branch: 'main',
      },
      sender: {
        login: 'developer-alice',
      },
    };

    const payloadStr = JSON.stringify(payloadObj);
    const signature = computeSignature(payloadStr, secret);

    const qLenBefore = await getQueueLength();

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      payload: payloadStr,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.event).toBe('push');
    expect(body.repository).toBe(repoName);
    expect(body.triggered).toBe(1);
    expect(body.runs).toHaveLength(1);

    const runId = body.runs[0].id;
    const run = await getWorkflowRun(runId);
    expect(run).toBeDefined();
    expect(run?.workflow_name).toBe('Build and Test');
    expect(run?.repository_id).toBe(repo.id);
    expect(run?.trigger_event).toBe('push');
    expect(run?.trigger_sender).toBe('developer-alice');
    expect(run?.commit_sha).toBe('9f8e7d6c5b4a');
    expect(run?.commit_ref).toBe('refs/heads/main');
    expect(run?.commit_message).toBe('feat: add awesome feature');

    // Verify jobs created and DAG staged properly
    const jobs = await getJobsByWorkflowRun(runId);
    expect(jobs).toHaveLength(2);

    const buildJob = jobs.find((j) => j.job_key === 'build');
    const testJob = jobs.find((j) => j.job_key === 'test');
    expect(buildJob?.status).toBe('queued');
    expect(testJob?.status).toBe('created');

    // Verify CI environment variables were injected into job command
    expect(buildJob?.command).toContain('export GITHUB_SHA="9f8e7d6c5b4a"');
    expect(buildJob?.command).toContain('export GITHUB_BRANCH="main"');
    expect(buildJob?.command).toContain(`export GITHUB_REPOSITORY="${repoName}"`);
    expect(buildJob?.command).toContain('export CI="true"');

    // Verify root job was pushed into Redis queue
    const redis = getRedisClient();
    const queuedItems = await redis.lrange(QUEUE_KEY, 0, -1);
    const inQueue = queuedItems.some((item) => {
      try {
        return JSON.parse(item).jobId === buildJob?.id;
      } catch {
        return false;
      }
    });
    expect(inQueue).toBe(true);
  });

  it('ignores branch deletion push event without error', async () => {
    const repoName = `org/branch-del-${Date.now()}`;
    await createRepository({ name: repoName });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'push',
      },
      payload: {
        ref: 'refs/heads/feature-old',
        deleted: true,
        after: '0000000000000000000000000000000000000000',
        repository: { full_name: repoName },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.triggered).toBe(0);
    expect(body.message).toContain('deletion');
  });

  it('does not trigger workflow when push branch does not match branch pattern', async () => {
    const repoName = `org/filter-repo-${Date.now()}`;
    const repo = await createRepository({ name: repoName });

    await createRegisteredWorkflow({
      repositoryId: repo.id,
      name: 'prod.yml',
      content: `
name: Production Deploy
on:
  push:
    branches: [main]
steps:
  - run: echo deploy
`,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'push',
      },
      payload: {
        ref: 'refs/heads/feature/login',
        after: '1122334455',
        repository: { full_name: repoName },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.triggered).toBe(0);
  });

  it('triggers workflow on pull_request opened event', async () => {
    const repoName = `org/pr-repo-${Date.now()}`;
    const repo = await createRepository({ name: repoName });

    await createRegisteredWorkflow({
      repositoryId: repo.id,
      name: 'pr-check.yml',
      content: `
name: Pull Request Check
on:
  pull_request:
    types: [opened, synchronize]
steps:
  - run: echo "PR validation"
`,
    });

    // 1. Opened PR -> should trigger
    const resOpened = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
      },
      payload: {
        action: 'opened',
        number: 42,
        pull_request: {
          title: 'Fix payment timeout bug',
          head: {
            ref: 'fix/payment',
            sha: 'pr-sha-999',
          },
        },
        repository: { full_name: repoName },
        sender: { login: 'contributor-bob' },
      },
    });

    expect(resOpened.statusCode).toBe(201);
    const openedBody = resOpened.json();
    expect(openedBody.triggered).toBe(1);
    expect(openedBody.runs[0].trigger_event).toBe('pull_request');
    expect(openedBody.runs[0].trigger_sender).toBe('contributor-bob');
    expect(openedBody.runs[0].commit_sha).toBe('pr-sha-999');

    // 2. Closed PR -> should be ignored
    const resClosed = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'x-github-event': 'pull_request',
      },
      payload: {
        action: 'closed',
        number: 42,
        pull_request: {
          title: 'Fix payment timeout bug',
          head: { ref: 'fix/payment', sha: 'pr-sha-999' },
        },
        repository: { full_name: repoName },
      },
    });

    expect(resClosed.statusCode).toBe(200);
    const closedBody = resClosed.json();
    expect(closedBody.triggered).toBe(0);
  });

  it('supports repository and workflow registration REST endpoints', async () => {
    const repoName = `api-test-org/repo-${Date.now()}`;

    // POST /repositories
    const createRes = await app.inject({
      method: 'POST',
      url: '/repositories',
      payload: {
        name: repoName,
        url: `https://github.com/${repoName}`,
        default_branch: 'main',
        webhook_secret: 'api-secret',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdRepo = createRes.json().repository;
    expect(createdRepo.id).toBeDefined();
    expect(createdRepo.name).toBe(repoName);

    // Duplicate name returns 409
    const dupRes = await app.inject({
      method: 'POST',
      url: '/repositories',
      payload: { name: repoName },
    });
    expect(dupRes.statusCode).toBe(409);

    // GET /repositories
    const listRes = await app.inject({
      method: 'GET',
      url: '/repositories?limit=10',
    });
    expect(listRes.statusCode).toBe(200);
    const { repositories } = listRes.json();
    expect(repositories.some((r: any) => r.id === createdRepo.id)).toBe(true);

    // GET /repositories/:id
    const getRes = await app.inject({
      method: 'GET',
      url: `/repositories/${createdRepo.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().repository.name).toBe(repoName);

    // POST /repositories/:id/workflows
    const wfRes = await app.inject({
      method: 'POST',
      url: `/repositories/${createdRepo.id}/workflows`,
      payload: {
        name: 'test-flow',
        content: `
name: API Registered Flow
on: push
steps:
  - run: echo "registered via API"
`,
      },
    });
    expect(wfRes.statusCode).toBe(201);
    expect(wfRes.json().workflow.name).toBe('test-flow');

    // GET /repositories/:id/workflows
    const listWfRes = await app.inject({
      method: 'GET',
      url: `/repositories/${createdRepo.id}/workflows`,
    });
    expect(listWfRes.statusCode).toBe(200);
    expect(listWfRes.json().workflows).toHaveLength(1);

    // DELETE /repositories/:id
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/repositories/${createdRepo.id}`,
    });
    expect(delRes.statusCode).toBe(200);

    const getAfterDel = await app.inject({
      method: 'GET',
      url: `/repositories/${createdRepo.id}`,
    });
    expect(getAfterDel.statusCode).toBe(404);
  });
});
