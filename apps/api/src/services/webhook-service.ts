import crypto from 'node:crypto';
import type {
  WorkflowRunRecord,
  GitHubPushPayload,
  GitHubPullRequestPayload,
  GitHubPingPayload,
} from '@mini-ci/types';
import { getRepositoryByName, listRegisteredWorkflows } from '@mini-ci/db';
import { shouldTriggerWorkflow, parseWorkflowContent } from './workflow-parser.js';
import { submitWorkflow } from './workflow-service.js';

export class InvalidSignatureError extends Error {
  statusCode = 401;
  code = 'INVALID_SIGNATURE';
  constructor(message = 'Invalid GitHub webhook signature') {
    super(message);
    this.name = 'InvalidSignatureError';
  }
}

export interface WebhookProcessResult {
  status: 'success' | 'ignored' | 'pong';
  event: string;
  repository?: string;
  matchedWorkflows?: number;
  runs?: WorkflowRunRecord[];
  reason?: string;
  zen?: string;
}

export function verifyGitHubSignature(
  rawPayload: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawPayload);
  const expectedSig = `sha256=${hmac.digest('hex')}`;

  const sigBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expectedSig);

  if (sigBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}

export async function processGitHubWebhook(options: {
  event: string;
  signature?: string;
  rawBody: string | Buffer;
  payload: Record<string, unknown>;
  secretOverride?: string;
}): Promise<WebhookProcessResult> {
  const { event, signature, rawBody, payload, secretOverride } = options;

  // Handle ping event immediately
  if (event === 'ping') {
    const pingPayload = payload as unknown as GitHubPingPayload;
    return {
      status: 'pong',
      event: 'ping',
      zen: pingPayload.zen ?? 'Keep it logically awesome.',
    };
  }

  // Identify repository name
  const repoData = payload['repository'] as { name?: string; full_name?: string } | undefined;
  const repoName = repoData?.full_name ?? repoData?.name;

  if (!repoName) {
    throw new Error('Missing repository information in webhook payload');
  }

  // Look up registered repository if exists
  const repo = await getRepositoryByName(repoName);

  // Determine secret to verify: secretOverride > repo.webhook_secret > process.env.GITHUB_WEBHOOK_SECRET
  const expectedSecret =
    secretOverride ?? repo?.webhook_secret ?? process.env['GITHUB_WEBHOOK_SECRET'] ?? undefined;

  if (!expectedSecret && process.env['MINI_CI_API_KEY']?.trim()) {
    throw new InvalidSignatureError('A webhook secret is required when API authentication is enabled');
  }

  if (expectedSecret) {
    const isValid = verifyGitHubSignature(rawBody, signature, expectedSecret);
    if (!isValid) {
      throw new InvalidSignatureError();
    }
  }

  let branch: string | undefined;
  let ref: string | undefined;
  let commitSha: string | undefined;
  let commitMessage: string | undefined;
  let sender: string | undefined;
  let action: string | undefined;

  if (event === 'push') {
    const push = payload as unknown as GitHubPushPayload;

    // Check for branch deletion
    if (push.deleted === true || push.after === '0000000000000000000000000000000000000000') {
      return {
        status: 'ignored',
        event,
        repository: repoName,
        matchedWorkflows: 0,
        runs: [],
        reason: 'Branch deletion event ignored',
      };
    }

    ref = push.ref ?? 'refs/heads/main';
    branch = ref.startsWith('refs/heads/') ? ref.slice(11) : ref;
    commitSha = push.after ?? push.head_commit?.id;
    commitMessage = push.head_commit?.message;
    sender = push.sender?.login ?? push.pusher?.name;
  } else if (event === 'pull_request') {
    const pr = payload as unknown as GitHubPullRequestPayload;
    action = pr.action;

    // Ignore unsupported actions like closed, labeled, etc.
    if (action && !['opened', 'synchronize', 'reopened'].includes(action)) {
      return {
        status: 'ignored',
        event,
        repository: repoName,
        matchedWorkflows: 0,
        runs: [],
        reason: `Pull request action "${action}" ignored`,
      };
    }

    ref = pr.pull_request?.head?.ref;
    branch = pr.pull_request?.base?.ref;
    commitSha = pr.pull_request?.head?.sha;
    commitMessage = pr.pull_request?.title;
    sender = pr.sender?.login;
  } else {
    return {
      status: 'ignored',
      event,
      repository: repoName,
      matchedWorkflows: 0,
      runs: [],
      reason: `Event "${event}" is not handled for automatic workflow triggers`,
    };
  }

  // Only registered workflows may be triggered by external webhook payloads.
  let registeredWorkflows: Array<{ name: string; content: string }> = [];

  if (repo) {
    const activeWfs = await listRegisteredWorkflows(repo.id, true);
    registeredWorkflows = activeWfs.map((w) => ({ name: w.name, content: w.content }));
  }

  if (registeredWorkflows.length === 0) {
    return {
      status: 'ignored',
      event,
      repository: repoName,
      matchedWorkflows: 0,
      runs: [],
      reason: 'No active workflows found for repository',
    };
  }

  const triggeredRuns: WorkflowRunRecord[] = [];

  for (const wf of registeredWorkflows) {
    const definition = parseWorkflowContent(wf.content);

    // Evaluate trigger filter
    if (!shouldTriggerWorkflow(definition, event, branch, action)) {
      continue;
    }

    // Build standard CI environment variables
    const ciEnv: Record<string, string> = {
      CI: 'true',
      MINI_CI: 'true',
      GITHUB_EVENT_NAME: event,
      GITHUB_REPOSITORY: repoName,
    };
    if (commitSha) ciEnv['GITHUB_SHA'] = commitSha;
    if (ref) ciEnv['GITHUB_REF'] = ref;
    if (branch) ciEnv['GITHUB_BRANCH'] = branch;
    if (sender) ciEnv['GITHUB_ACTOR'] = sender;

    const result = await submitWorkflow(definition, {
      repositoryId: repo?.id,
      triggerEvent: event,
      triggerSender: sender,
      commitSha,
      commitRef: ref,
      commitMessage,
      env: ciEnv,
    });

    triggeredRuns.push(result.run);
  }

  return {
    status: triggeredRuns.length > 0 ? 'success' : 'ignored',
    event,
    repository: repoName,
    matchedWorkflows: triggeredRuns.length,
    runs: triggeredRuns,
    reason: triggeredRuns.length === 0 ? 'No workflows matched event and branch criteria' : undefined,
  };
}
