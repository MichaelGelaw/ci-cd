import type { JobStatus } from '@mini-ci/types';

// Legal state transitions defined in docs/job-lifecycle.md
const LEGAL_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  created: ['queued', 'cancelled'],
  queued: ['assigned', 'cancelled'],
  assigned: ['running', 'failed', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled', 'timed_out'],
  failed: ['retrying'],
  timed_out: ['retrying'],
  retrying: ['queued', 'cancelled'],
  succeeded: [],
  cancelled: [],
};

export function isValidTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) {
    return true;
  }
  const allowed = LEGAL_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function assertValidTransition(from: JobStatus, to: JobStatus): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`Invalid job state transition: cannot transition from ${from} to ${to}`);
  }
}
