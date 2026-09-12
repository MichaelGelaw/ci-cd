# ADR 002: Lease Fencing and Stale Worker Recovery

## Status
Accepted

## Context
In distributed execution environments, workers can experience temporary freezes, prolonged garbage collection pauses, network disconnections, or out-of-memory crashes. If a worker pauses, another worker might be reassigned its job. When the original worker unfreezes, it might resume execution and attempt to write results, causing a "split-brain" scenario where two workers concurrently execute the same job or corrupt state.

## Decision
We implement optimistic lease fencing combined with automated dead-worker reaping and stale job recovery:

### 1. Job Leases and Fencing Tokens
- When a worker claims or begins a job, PostgreSQL generates a unique `lease_token` (UUID) with a bounded expiration timestamp (`lease_expires_at = NOW() + lease_duration_seconds`).
- While executing, the worker runs a background `LeaseRenewer` daemon thread that periodically issues HTTP `POST /jobs/:id/lease` with its current `lease_token`.
- Every lease renewal checks `WHERE id = $1 AND lease_token = $2 AND status = 'running'`.
- If a worker's lease expires and the scheduler reclaims the job, a new `lease_token` is generated.
- If the stale worker attempts to renew or report status with an outdated token, the control plane responds with HTTP 409 `LEASE_CONFLICT`.
- The worker's `on_conflict` callback immediately sets its local `cancellation_event`, killing subprocesses or Docker containers to prevent dual execution.

### 2. Automated Dead Worker Reaping & Job Recovery
- Workers submit periodic heartbeats (`POST /workers/:id/heartbeat`).
- On every scheduler evaluation cycle (`/scheduler/tick`), the control plane executes two recovery passes:
  1. `reapDeadWorkers(timeoutSeconds)`: Workers whose `last_heartbeat_at` is older than the timeout threshold are marked `offline`.
  2. `recoverStaleJobs()`: Jobs in `running` or `assigned` status whose `lease_expires_at < NOW()` have their leases revoked.
- If remaining retry attempts exist, the job transitions `running -> timed_out / failed -> retrying -> queued` with exponential backoff.
- If attempts are exhausted, the job and its workflow run transition to `failed`.

## Consequences
### Positive
- Strict split-brain immunity: obsolete workers are deterministically rejected with HTTP 409 and terminated locally.
- Autonomous recovery: worker process crashes require no manual intervention; unfinished jobs are safely rescheduled.

### Negative
- Requires periodic HTTP traffic for heartbeats and lease renewals. Overhead is minimal (single lightweight query per 10-30 seconds per active job).
