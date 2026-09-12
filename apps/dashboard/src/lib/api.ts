import type {
  SystemStats,
  WorkflowRunRecord,
  JobRecord,
  WorkerRecord,
  RepositoryRecord,
  RegisteredWorkflowRecord,
  ArtifactRecord,
  LogChunk,
  LogEndEvent,
} from '@mini-ci/types';

export const API_BASE =
  typeof window !== 'undefined'
    ? process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3000'
    : process.env.API_INTERNAL_URL || 'http://127.0.0.1:3000';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    let errorMsg = `HTTP ${res.status} ${res.statusText}`;
    try {
      const errJson = await res.json();
      errorMsg = errJson.error?.message || errJson.message || errorMsg;
    } catch {
      // Ignore parse failure
    }
    throw new Error(errorMsg);
  }

  return res.json() as Promise<T>;
}

export async function getStats(): Promise<SystemStats> {
  const data = await request<{ stats: SystemStats }>('/stats');
  return data.stats;
}

export async function listWorkflowRuns(
  limit: number = 20,
  offset: number = 0,
): Promise<{ runs: WorkflowRunRecord[]; limit: number; offset: number }> {
  return request<{ runs: WorkflowRunRecord[]; limit: number; offset: number }>(
    `/workflow-runs?limit=${limit}&offset=${offset}`,
  );
}

export async function getWorkflowRun(
  id: string,
): Promise<{ run: WorkflowRunRecord; jobs: JobRecord[] }> {
  return request<{ run: WorkflowRunRecord; jobs: JobRecord[] }>(`/workflow-runs/${id}`);
}

export async function cancelWorkflowRun(id: string, reason?: string): Promise<void> {
  await request(`/workflow-runs/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason || 'Cancelled from web dashboard' }),
  });
}

export async function getJob(id: string): Promise<{ job: JobRecord }> {
  return request<{ job: JobRecord }>(`/jobs/${id}`);
}

export async function cancelJob(id: string, reason?: string): Promise<void> {
  await request(`/jobs/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason || 'Cancelled from web dashboard' }),
  });
}

export async function getJobLogs(
  id: string,
): Promise<{ jobId: string; logs: string[]; live: boolean }> {
  return request<{ jobId: string; logs: string[]; live: boolean }>(`/jobs/${id}/logs`);
}

export async function listWorkers(
  limit: number = 50,
  offset: number = 0,
): Promise<{ workers: WorkerRecord[]; limit: number; offset: number }> {
  return request<{ workers: WorkerRecord[]; limit: number; offset: number }>(
    `/workers?limit=${limit}&offset=${offset}`,
  );
}

export async function listRepositories(
  limit: number = 50,
  offset: number = 0,
): Promise<{ repositories: RepositoryRecord[]; limit: number; offset: number }> {
  return request<{ repositories: RepositoryRecord[]; limit: number; offset: number }>(
    `/repositories?limit=${limit}&offset=${offset}`,
  );
}

export async function getRepository(id: string): Promise<{ repository: RepositoryRecord }> {
  return request<{ repository: RepositoryRecord }>(`/repositories/${id}`);
}

export async function createRepository(params: {
  name: string;
  url?: string;
  default_branch?: string;
  webhook_secret?: string;
}): Promise<{ repository: RepositoryRecord }> {
  return request<{ repository: RepositoryRecord }>('/repositories', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function listRepositoryWorkflows(
  repoId: string,
): Promise<{ workflows: RegisteredWorkflowRecord[] }> {
  return request<{ workflows: RegisteredWorkflowRecord[] }>(`/repositories/${repoId}/workflows`);
}

export async function createRepositoryWorkflow(
  repoId: string,
  params: { name?: string; content: string; path?: string; is_active?: boolean },
): Promise<{ workflow: RegisteredWorkflowRecord }> {
  return request<{ workflow: RegisteredWorkflowRecord }>(`/repositories/${repoId}/workflows`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function listArtifacts(
  limit: number = 50,
  offset: number = 0,
): Promise<{ artifacts: ArtifactRecord[]; limit: number; offset: number }> {
  return request<{ artifacts: ArtifactRecord[]; limit: number; offset: number }>(
    `/artifacts?limit=${limit}&offset=${offset}`,
  );
}

export async function getJobArtifacts(
  jobId: string,
): Promise<{ artifacts: ArtifactRecord[] }> {
  return request<{ artifacts: ArtifactRecord[] }>(`/jobs/${jobId}/artifacts`);
}

export async function getRunArtifacts(
  runId: string,
): Promise<{ artifacts: ArtifactRecord[] }> {
  return request<{ artifacts: ArtifactRecord[] }>(`/workflow-runs/${runId}/artifacts`);
}

export function getArtifactDownloadUrl(id: string): string {
  return `${API_BASE}/artifacts/${id}/download`;
}

export function subscribeJobLogs(
  jobId: string,
  onChunk: (chunk: LogChunk) => void,
  onEnd: (endEvent?: LogEndEvent) => void,
  onError?: (err: Event) => void,
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const eventSource = new EventSource(`${API_BASE}/jobs/${jobId}/logs/stream`);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === 'end') {
        onEnd(data as LogEndEvent);
      } else if (data.data !== undefined) {
        onChunk(data as LogChunk);
      }
    } catch {
      // Ignore unparseable frames
    }
  };

  eventSource.onerror = (err) => {
    if (onError) onError(err);
    eventSource.close();
  };

  return () => {
    eventSource.close();
  };
}
