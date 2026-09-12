import type { LogChunk, LogEndEvent, LogEvent, JobRecord } from '@mini-ci/types';
import { getJob } from '@mini-ci/db';
import { getBufferedLogs, subscribeJobLogs } from '@mini-ci/queue';

export interface JobLogsResult {
  jobId: string;
  status: string;
  stdout: string;
  stderr: string;
  events: LogEvent[];
}

export async function getJobLogsService(jobId: string): Promise<JobLogsResult | null> {
  const job = await getJob(jobId);
  if (!job) {
    return null;
  }

  const bufferedEvents = await getBufferedLogs(jobId);

  // If job is terminal and has DB output, prefer DB output or combine with buffered
  let stdout = job.stdout || '';
  let stderr = job.stderr || '';

  // If DB stdout/stderr is empty but buffered events exist, reconstruct from buffered chunks
  if (!stdout && bufferedEvents.length > 0) {
    stdout = bufferedEvents
      .filter((e): e is LogChunk => 'stream' in e && e.stream === 'stdout')
      .map((c) => c.data)
      .join('');
  }

  if (!stderr && bufferedEvents.length > 0) {
    stderr = bufferedEvents
      .filter((e): e is LogChunk => 'stream' in e && e.stream === 'stderr')
      .map((c) => c.data)
      .join('');
  }

  return {
    jobId,
    status: job.status,
    stdout,
    stderr,
    events: bufferedEvents,
  };
}

export { getBufferedLogs, subscribeJobLogs };
