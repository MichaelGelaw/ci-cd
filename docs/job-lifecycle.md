# Job Lifecycle

## State Machine

A job moves through a defined set of states. Only specific transitions are legal.

```
CREATED
   |
   v
QUEUED ----------+
   |              |
   v              |
ASSIGNED          |
   |              |
   v              |
RUNNING           |
   |              |
   +---> SUCCEEDED|
   |              |
   +---> FAILED --+---> RETRYING ---> QUEUED
   |              |
   +---> CANCELLED|
   |              |
   +---> TIMED_OUT+---> RETRYING ---> QUEUED
```

### States

| State | Description |
|-------|-------------|
| CREATED | Job record exists but has not been submitted to the queue |
| QUEUED | Job is waiting in the queue for a worker |
| ASSIGNED | A worker has claimed the job but has not started execution |
| RUNNING | The job is actively executing |
| SUCCEEDED | Execution completed with exit code 0 |
| FAILED | Execution completed with a non-zero exit code or an error |
| TIMED_OUT | Execution exceeded its timeout and was killed |
| CANCELLED | The job was cancelled by a user or the system |
| RETRYING | The job failed but is eligible for retry; will re-enter QUEUED |

### Terminal States

SUCCEEDED, FAILED, CANCELLED, and TIMED_OUT are terminal once retry attempts are exhausted. A job in a terminal state cannot transition back to RUNNING or QUEUED.

## Legal Transitions

```
CREATED    -> QUEUED
CREATED    -> CANCELLED
QUEUED     -> ASSIGNED
QUEUED     -> CANCELLED
ASSIGNED   -> RUNNING
ASSIGNED   -> CANCELLED
RUNNING    -> SUCCEEDED
RUNNING    -> FAILED
RUNNING    -> CANCELLED
RUNNING    -> TIMED_OUT
FAILED     -> RETRYING     (if attempts remain)
TIMED_OUT  -> RETRYING     (if attempts remain and failure is retryable)
RETRYING   -> QUEUED
```

Any transition not listed above is invalid and must be rejected. For example, `SUCCEEDED -> RUNNING` is never allowed.

## Attempts

Each execution of a job is an attempt. When a job retries, a new attempt is created. The job record tracks the current attempt number and the maximum allowed attempts.

```
Job
 |
 +-- Attempt 1: FAILED  (exit code 1, worker-3, 12s)
 +-- Attempt 2: FAILED  (timed out, worker-1, 300s)
 +-- Attempt 3: SUCCEEDED (exit code 0, worker-2, 8s)
```

Previous attempts are preserved for debugging and audit.

## Leases

When a worker claims a job, it receives a lease with an expiration time. The worker must periodically renew the lease while the job is running. If the lease expires (because the worker crashed or lost connectivity), the job becomes eligible for recovery.

```
Worker claims job
       |
       v
  Lease granted (expires at T)
       |
       v
  Worker renews lease periodically
       |
       v
  Job completes -> lease released
```

If the lease expires:

```
  Lease expires
       |
       v
  Scheduler detects stale job
       |
       v
  Job transitions to FAILED or RETRYING
       |
       v
  Re-queued if retries remain
```

## Retry Policy

Not all failures are retryable:

| Failure Type | Retryable | Example |
|-------------|-----------|---------|
| Infrastructure failure | Yes | Worker crashed, network timeout |
| Timeout | Configurable | Job exceeded deadline |
| User/build failure | No | Test assertion failed, syntax error |

Retry delay uses exponential backoff with jitter:

```
delay = base_delay * 2^attempt + random_jitter
```

Maximum retry attempts are configured per job.

## Cancellation

Cancellation is not just a database flag. The control plane must propagate the cancellation to the worker, which must terminate the running process or container. A cancelled job's lease is released immediately.
