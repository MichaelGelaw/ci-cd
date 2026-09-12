# ADR 001: PostgreSQL as Single Source of Truth

## Status
Accepted

## Context
In distributed CI/CD architectures, coordinating workflows across concurrent workers involves managing job states, worker heartbeats, leases, retry policies, and execution logs. A common pitfall in distributed build runners is split-state or state drift between caching/queuing systems (e.g., Redis) and durable stores (e.g., SQL databases), leading to phantom jobs, double executions, or lost terminal states when components crash.

## Decision
We designate PostgreSQL as the single, authoritative source of truth for all workflow run states, job statuses, attempt histories, worker registries, repository configurations, and artifact metadata.
Redis is used exclusively for ephemeral coordination:
1. Reliable FIFO job dispatch queues (`minici:jobs:queue` and worker-targeted queues `minici:jobs:queue:{workerId}`) using `LPUSH`, `BRPOPLPUSH`, and atomic Lua acknowledgment.
2. Real-time log distribution via Redis Pub/Sub channels and sliding list buffers (`minici:logs:{jobId}`).
3. Fast-path cancellation flags and Pub/Sub notifications (`minici:jobs:cancelled:{jobId}`).

### Invariants Enforced
- Job state transitions (`created -> queued -> assigned -> running -> succeeded / failed / timed_out / cancelled`) must execute atomically within PostgreSQL transactions.
- Transition directly from `queued` to terminal states without worker assignment is rejected by the state machine validator.
- Redis queues mirror PostgreSQL state. If Redis restarts or drops data, the scheduler reconciles disparities by scanning PostgreSQL for jobs in `queued` status and re-enqueuing them without duplicating database rows.

## Consequences
### Positive
- Strict ACID compliance: impossible for jobs to disappear into an unrecoverable state upon process failure.
- Complete auditability: every attempt, exit code, stdout/stderr snippet, and status duration is durably recorded in PostgreSQL.
- Simple disaster recovery: Redis can be flushed or restarted without data loss.

### Negative
- Higher database read/write volume during high-concurrency bursts, mitigated by connection pooling (`DB_POOL_MAX` tuned up to 25+ connections) and indexed state lookups.
