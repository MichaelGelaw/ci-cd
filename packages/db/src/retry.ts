import type { RetryPolicy, JobStatus } from '@mini-ci/types';

export function calculateRetryDelay(
  attempt: number,
  policy: RetryPolicy = {},
): number {
  const baseDelay = policy.base_delay_seconds ?? 1;
  const maxDelay = policy.max_delay_seconds ?? 60;
  const factor = policy.backoff_factor ?? 2;
  const useJitter = policy.jitter !== false;

  // Exponential backoff: baseDelay * (factor ^ (attempt - 1))
  const exponent = Math.max(0, attempt - 1);
  let delay = baseDelay * Math.pow(factor, exponent);
  delay = Math.min(delay, maxDelay);

  if (useJitter) {
    // Proportional random jitter up to 25% of delay or 2 seconds max
    const jitter = Math.random() * Math.min(delay * 0.25, 2.0);
    delay += jitter;
  }

  return Math.round(delay * 1000) / 1000;
}

export function isFailureRetryable(
  status: JobStatus,
  policy: RetryPolicy = {},
): boolean {
  if (status === 'timed_out') {
    return policy.retry_on_timeout !== false;
  }
  if (status === 'failed') {
    return true;
  }
  return false;
}
