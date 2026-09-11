# Architecture

## Overview

mini-ci is a CI/CD platform that accepts workflow definitions, schedules jobs across distributed workers, executes commands inside containers, and reports results.

The system is split into a TypeScript control plane and Python execution workers, communicating through a Redis job queue with PostgreSQL as the durable source of truth.

## Current Architecture (Milestone 1)

```
CLI
 |
 v
Workflow YAML --> Parser --> Executor --> Reporter
                                |
                                v
                         child_process.spawn
                                |
                                v
                         Command (shell)
                                |
                                v
                      stdout / stderr / exit code
```

Everything runs in a single process. No networking, no databases, no containers.

## Target Architecture

```
                    GitHub
                      |
                   Webhook
                      |
                      v
              +---------------+
              | TypeScript API|
              +-------+-------+
                      |
          +-----------+-----------+
          |                       |
          v                       v
     PostgreSQL                 Redis
          |                       |
          |                Job Queue / Events
          |                       |
          +-----------+-----------+
                      |
                      v
                 Scheduler
                      |
              +-------+-------+
              |               |
              v               v
          Worker 1         Worker 2
              |               |
              v               v
           Docker          Docker
              |               |
              v               v
          Build/Test       Build/Test
              |               |
              +-------+-------+
                      |
                      v
               Logs / Artifacts
                      |
                      v
                  Dashboard
```

### Components

**API (TypeScript)** -- REST API for repositories, workflows, jobs, and workers. Validates requests, manages state, and serves the dashboard.

**Scheduler (TypeScript)** -- Determines which queued jobs should run and on which workers. Enforces concurrency limits, priority, and capability matching.

**Worker (Python)** -- Pulls jobs from the queue, prepares workspaces, launches Docker containers, streams logs, collects artifacts, and reports results via heartbeats.

**PostgreSQL** -- Durable source of truth for all state: repositories, workflows, runs, jobs, workers, artifacts.

**Redis** -- Job queue, pub/sub for events, ephemeral coordination. Not the source of truth for correctness -- a lost Redis message can be recovered from PostgreSQL.

**Dashboard (Next.js)** -- Displays repositories, workflows, runs, jobs, workers, logs, and artifacts.

## Milestones

| # | Milestone | Description |
|---|-----------|-------------|
| 1 | Local runner | Sequential command execution via child processes |
| 2 | Docker runner | Replace shell execution with Docker containers |
| 3 | Persistence | PostgreSQL job storage and state management |
| 4 | API | TypeScript REST API for job submission and queries |
| 5 | Queue | Redis-based async job delivery |
| 6 | Worker | Python worker consuming from the queue |
| 7 | Registration | Worker registration with the control plane |
| 8 | Scheduler | Job-to-worker assignment logic |
| 9 | Heartbeats | Periodic worker liveness checks |
| 10 | Leases | Time-bounded job ownership |
| 11 | Retries | Configurable retry policies with backoff |
| 12 | Recovery | Automatic recovery from worker failures |
| 13 | Live logs | Real-time log streaming via WebSocket/SSE |
| 14 | Cancellation | Job cancellation with process termination |
| 15 | Artifacts | Job artifact collection and storage |
| 16 | Workflow YAML | Multi-job workflow definitions |
| 17 | DAG scheduling | Dependency-based job ordering |
| 18 | GitHub webhook | Trigger workflows from GitHub events |
| 19 | Dashboard | Web UI for monitoring |
| 20 | Observability | Metrics, structured logging |
| 21 | Failure injection | Intentional failure testing |
| 22 | Load testing | Performance under high job volume |
| 23 | Polish | Documentation, cleanup, hardening |

## Design Principles

- PostgreSQL is the source of truth. Redis is for coordination.
- Jobs have explicit state machines with legal transitions.
- Workers are untrusted execution environments. The control plane enforces invariants.
- Failures are expected. The system recovers from worker crashes, lost messages, and stale leases.
- At-least-once delivery means duplicate execution is possible. Operations must be idempotent.
- Build incrementally. Each milestone should produce a working system.
