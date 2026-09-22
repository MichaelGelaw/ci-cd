# mini-ci: Distributed CI/CD Platform

A miniature, resilient continuous integration and continuous delivery platform that executes workflows across distributed workers with dependency scheduling (DAGs), container isolation, optimistic lease fencing, live log streaming, GitHub webhook integration, and real-time dashboard monitoring.

---

## Architecture Overview

mini-ci is designed with strict separation between durable state, queue coordination, and untrusted execution workers:

```
+-----------------------------------------------------------------------------------+
|                                  mini-ci Architecture                            |
+-----------------------------------------------------------------------------------+

   Developers / GitHub Webhooks                   Web Dashboard (Next.js 15)
              |                                               |
              v                                               v
   +--------------------+     HTTP REST API      +-------------------------+
   |   GitHub Webhook   | ---------------------> | Control Plane (Fastify) |
   | HMAC-SHA256 Secret |                        | - Rate Limiter          |
   +--------------------+                        | - API Key Auth          |
                                                 | - DAG Parser & Stager   |
                                                 | - Prometheus Metrics    |
                                                 +-------------------------+
                                                              |
                              +-------------------------------+-------------------------------+
                              |                                                               |
                              v                                                               v
                 +--------------------------+                                   +--------------------------+
                 | PostgreSQL 16 (Durable)  |                                   |  Redis 7 (Coordination)  |
                 | - Single Source of Truth |                                   | - Reliable Job Queue     |
                 | - Workflow Runs & DAGs   |                                   | - Dedicated Worker Queue |
                 | - Atomic State Machine   |                                   | - Real-time Log Pub/Sub  |
                 | - Leases & Retry Policy  |                                   | - Fast-Path Cancel Flags |
                 | - Artifact Storage Meta  |                                   | - Atomic Lua Acknowledge |
                 +--------------------------+                                   +--------------------------+
                              ^                                                               ^
                              |                                                               |
              Heartbeats / Leases / Status                                            BRPOPLPUSH / Logs
                              |                                                               |
              +---------------+---------------+                               +---------------+---------------+
              |                               |                               |                               |
              v                               v                               v                               v
   +---------------------+         +---------------------+         +---------------------+         +---------------------+
   | Python Worker 1     |         | Python Worker 2     |         | CLI Local Runner    |         | CLI Docker Runner   |
   | - Docker / Subproc  |         | - Capability Match  |         | - In-Memory DAG     |         | - Isolated Container|
   | - Heartbeat Daemon  |         | - Lease Renewer     |         | - Local Subprocess  |         | - Volume Mount      |
   | - Log Streamer      |         | - Cancellation Poll |         | - Real-Time Timing  |         | - Workspace Cleanup |
   +---------------------+         +---------------------+         +---------------------+         +---------------------+
```

### Core Architecture Invariants

1. **PostgreSQL is the Single Source of Truth**: All workflow run records, job statuses, execution attempts, worker heartbeats, and artifact references are persisted durably in PostgreSQL.
2. **Redis is for Coordination Only**: Redis manages reliable FIFO job dispatching (`LPUSH`, `BRPOPLPUSH`), real-time log publishing, and cancellation broadcast. If Redis is restarted or cleared, the scheduler reconciles disparities from PostgreSQL without duplicating state.
3. **Optimistic Lease Fencing**: Workers acquire time-bounded leases with unique UUID tokens. Stale workers attempting to renew expired leases or write results are rejected with HTTP 409 `LEASE_CONFLICT` and aborted locally, eliminating split-brain races.
4. **Distributed DAG Resolution**: Multi-job pipelines model dependencies via `needs` declarations. Root jobs queue immediately, while dependent jobs remain staged in `created` status until all prerequisite jobs succeed.
5. **Execution Modes**: Workers run commands in Docker containers or trusted host-shell processes, stream logs line-by-line via Redis Pub/Sub, and enforce execution timeouts and artifact boundaries.

---

## Monorepo Layout

```
mini-ci/
  apps/
    api/              Control plane REST API service (Fastify, TypeScript)
    dashboard/        Web management console and log viewer (Next.js 15, CSS)
    runner/           Local CLI execution engine with DAG parsing (TypeScript)
    worker/           Autonomous distributed execution worker (Python 3.14)
  packages/
    types/            Shared TypeScript domain types and schemas
    db/               PostgreSQL connection pooling, migrations, and repository
    queue/            Redis reliable queues, log streams, and cancellation pub/sub
    scheduler/        Capability matcher, priority scheduler, and recovery loops
  database/
    migrations/       Sequential SQL schema migrations (001 to 007)
  docs/
    adr/              Architecture Decision Records (ADR 001 to 003)
    architecture.md   System design and component interactions
    job-lifecycle.md  Job state machine diagram and transition rules
  scripts/
    load-test.ts      High-volume performance benchmark tool
  workflows/
    examples/         Example workflow YAML templates (single and multi-job)
```

---

## Prerequisites

- **Linux / WSL 2 (Ubuntu 22.04+) / macOS**
- **Node.js**: `v20.19+`, `v22.12+`, or `v24.x`
- **pnpm**: `v9.x` or `v12.x`
- **Python**: `v3.10+` (recommended: `v3.14`)
- **Docker & Docker Compose**: `v24+`

---

## Quickstart

### 1. Start Infrastructure Services

Launch PostgreSQL 16 and Redis 7 using Docker Compose:

```bash
docker compose up -d
```

Verify that containers are healthy:
- PostgreSQL: `localhost:5432` (`mini-ci-postgres`)
- Redis: `localhost:6379` (`mini-ci-redis`)

### 2. Install Dependencies and Run Database Migrations

```bash
pnpm install
```

Migrations run automatically when the API starts or the local runner uses `--persist`.

### 3. Start the Control Plane API

```bash
pnpm --filter @mini-ci/api dev
```

The Fastify server starts on `http://localhost:3000`. Verify system health:

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"2026-09-12T20:55:00.000Z"}
```

### 4. Setup and Launch the Python Worker

Initialize the Python virtual environment and start the worker daemon:

```bash
cd apps/worker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Start worker connected to local control plane and Redis
python -m src.main
```

Worker logs confirm registration with capabilities `shell`, `docker`, and `linux`:
```
{"timestamp": "...", "level": "INFO", "message": "Worker worker-xxxx registered successfully"}
{"timestamp": "...", "level": "INFO", "message": "Starting queue consumer loop..."}
```

### 5. Launch the Web Dashboard

```bash
pnpm --filter @mini-ci/dashboard dev
```

Open `http://localhost:3001` in your browser to inspect workflow runs, worker nodes, active jobs, artifacts, and live streaming logs.

When API authentication is enabled, enter the API key under **API access**. The key
is stored for the current browser tab and sent in authorization headers, including
for log streams and artifact downloads. Browser requests use the dashboard's same-origin
`/api-proxy` route by default; set `API_INTERNAL_URL` for a remote control plane or
`NEXT_PUBLIC_API_URL` to explicitly use a browser-accessible API URL.

---

## CLI Local Runner

mini-ci includes a standalone command-line executor (`@mini-ci/runner`) for validating and running workflows locally without requiring the distributed worker cluster.

### Basic Execution

```bash
pnpm dev:runner workflows/examples/hello.yml
```

### Options and Flags

| Flag | Description |
| :--- | :--- |
| `--shell` | Force trusted host-shell execution even when images are configured |
| `--persist` | Persist run and job metadata into PostgreSQL |
| `--json` | Emit structured JSON execution results to stdout |

Images configured on a workflow, job, or step select Docker execution automatically.
Host-shell execution inherits the runner's permissions; use it only for trusted workflows.

### Example Workflow Definitions

#### Single-Job Sequential Pipeline (`workflows/examples/hello.yml`)
```yaml
name: hello-world
image: alpine:latest

steps:
  - name: greet
    run: echo "Hello from mini-ci"
  - name: test-tools
    run: uname -a && date
    timeout_seconds: 10
```

#### Multi-Job DAG Pipeline with Artifacts (`workflows/examples/multi-job.yml`)
```yaml
name: build-and-test-pipeline

jobs:
  build:
    name: Build Application
    image: node:20-alpine
    steps:
      - run: echo "building package..." && mkdir -p dist && echo "bundle" > dist/app.js
    artifacts:
      paths:
        - dist/**

  lint:
    name: Code Linting
    image: node:20-alpine
    steps:
      - run: echo "linting source files..."

  test:
    name: Unit & Integration Tests
    needs: [build]
    image: node:20-alpine
    steps:
      - run: echo "running tests against build artifact..."

  deploy:
    name: Production Deployment
    needs: [test, lint]
    image: alpine:latest
    steps:
      - run: echo "deploying artifacts to production..."
```

---

## Worker Configuration

The Python worker daemon (`apps/worker`) is configured via environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `API_URL` | `http://localhost:3000` | Control plane URL |
| `MINI_CI_API_KEY` | unset | API token shared with the control plane (`API_KEY` is a worker fallback) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `WORKER_ID` | `worker-<uuid>` | Unique worker identifier |
| `WORKER_NAME` | hostname | Display name |
| `WORKER_TAGS` | `docker,shell,<platform>` | Advertised capabilities |
| `WORKER_QUEUE` | dedicated worker queue | Optional queue override |
| `POLL_TIMEOUT_SECONDS` | `2` | Blocking queue poll timeout |
| `HEARTBEAT_INTERVAL_SECONDS` | `5` | Heartbeat interval |
| `LOG_TTL_SECONDS` | `86400` | Buffered log retention |

Lease renewal runs every third of the granted lease duration. Docker limits default to
512 MiB memory and one CPU. The host-shell mode does not provide a security sandbox.

---

## Control Plane REST API Reference

All requests accept and return standard JSON. When `MINI_CI_API_KEY` is configured, client requests require `Authorization: Bearer <token>` or `x-api-key: <token>`.

### Workflows & Runs

| Method | Path | Description | Response Codes |
| :--- | :--- | :--- | :--- |
| `POST` | `/workflows/runs` | Submit and trigger workflow YAML run | `201 Created`, `400 Bad Request` |
| `GET` | `/workflow-runs` | List recent workflow runs (supports `?limit=` and `?offset=`) | `200 OK` |
| `GET` | `/workflow-runs/:id` | Get details, trigger metadata, and job list for run | `200 OK`, `404 Not Found` |
| `POST` | `/workflow-runs/:id/cancel` | Cancel run and abort all in-progress jobs | `200 OK`, `400 Bad Request` |

Leased job status reports must include both `worker_id` and the current `lease_token`.
Expired or replaced leases receive HTTP 409. Sequential steps remain staged until their
predecessor succeeds, and workflow submissions are committed atomically.

### Jobs & Execution

| Method | Path | Description | Response Codes |
| :--- | :--- | :--- | :--- |
| `GET` | `/jobs/:id` | Get full job state, attempts history, and lease metadata | `200 OK`, `404 Not Found` |
| `POST` | `/jobs/:id/status` | Update job state (`running`, `succeeded`, `failed`, etc.) | `200 OK`, `400 Bad Request`, `409 Conflict` |
| `POST` | `/jobs/:id/lease/renew` | Renew active execution lease token (prevents timeout) | `200 OK`, `409 Conflict (Fencing)` |
| `GET` | `/jobs/:id/logs` | Fetch execution logs (`?format=text` and `?stream=stdout|stderr`) | `200 OK` |
| `GET` | `/jobs/:id/logs/stream` | Real-time Server-Sent Events (SSE) live log stream | `200 OK (text/event-stream)` |

### Workers & Scheduling

| Method | Path | Description | Response Codes |
| :--- | :--- | :--- | :--- |
| `POST` | `/workers/register` | Register new worker with capability tags and metadata | `200 OK` |
| `GET` | `/workers` | List registered workers with health status (`ready`, `offline`) | `200 OK` |
| `GET` | `/workers/:id` | Get individual worker information and active assignments | `200 OK`, `404 Not Found` |
| `POST` | `/workers/:id/heartbeat`| Send heartbeat keeping worker marked `ready` | `200 OK` |
| `POST` | `/scheduler/tick` | Trigger scheduling round (promotes DAGs, reaps dead workers) | `200 OK` |

### Artifacts

| Method | Path | Description | Response Codes |
| :--- | :--- | :--- | :--- |
| `POST` | `/jobs/:id/artifacts` | Upload artifact binary stream or multipart archive | `201 Created`, `400 Bad Request` |
| `GET` | `/jobs/:id/artifacts` | List artifacts generated by a specific job | `200 OK` |
| `GET` | `/artifacts` | List all system-wide artifacts | `200 OK` |
| `GET` | `/artifacts/:id/download`| Download artifact binary file | `200 OK (octet-stream)` |

### Repositories & GitHub Webhooks

| Method | Path | Description | Response Codes |
| :--- | :--- | :--- | :--- |
| `POST` | `/repositories` | Connect Git repository with optional webhook secret | `201 Created` |
| `GET` | `/repositories` | List connected repositories | `200 OK` |
| `GET` | `/repositories/:id` | Get repository configuration | `200 OK`, `404 Not Found` |
| `DELETE`| `/repositories/:id` | Delete repository configuration | `200 OK` |
| `POST` | `/repositories/:id/workflows` | Register workflow YAML file associated with repo | `201 Created` |
| `GET` | `/repositories/:id/workflows` | List workflows registered for repository | `200 OK` |
| `POST` | `/webhooks/github` | Receive GitHub webhook events (`push`, `pull_request`, `ping`) | `200 OK`, `400 Bad Request`, `401 Unauthorized` |

### Observability & System Stats

| Method | Path | Description | Response Codes |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Liveness check | `200 OK` |
| `GET` | `/health/ready` | Readiness check (validates PostgreSQL and Redis connectivity) | `200 OK`, `503 Service Unavailable` |
| `GET` | `/metrics` | Prometheus metrics endpoint | `200 OK (text/plain)` |
| `GET` | `/stats` | System summary statistics (counts of runs, jobs, workers) | `200 OK` |

---

## GitHub Webhook Integration

mini-ci integrates with GitHub webhooks using HMAC-SHA256 signature verification.
When `MINI_CI_API_KEY` is set, webhook execution also requires a repository secret or
`GITHUB_WEBHOOK_SECRET`. Webhooks execute registered workflows only; payloads cannot
provide inline workflow commands. Pull request branch filters apply to the target branch.

### Setup Instructions

1. Register your repository in mini-ci:
   ```bash
   curl -X POST http://localhost:3000/repositories \
     -H "Content-Type: application/json" \
     -d '{
       "name": "my-org/my-project",
       "url": "https://github.com/my-org/my-project.git",
       "default_branch": "main",
       "webhook_secret": "my-super-secret-token"
     }'
   ```
2. In GitHub repository settings, add Webhook:
   - **Payload URL**: `http://<your-host>:3000/webhooks/github`
   - **Content type**: `application/json`
   - **Secret**: `my-super-secret-token`
   - **Events**: Select `Pushes` and `Pull requests`
3. When pushes or PRs occur, mini-ci verifies the `X-Hub-Signature-256` header, extracts branch and commit metadata, evaluates trigger branch patterns (e.g. `main`, `release/*`), and triggers automated workflow runs.

---

## Performance & Load Testing

mini-ci includes a high-volume performance testing harness (`scripts/load-test.ts`) that benchmarks job submission throughput, scheduler latency, queue capacity, and Redis pub/sub stability.

Run the load benchmark:

```bash
pnpm test:load --workflows 50 --concurrency 10 --workers 5
```

### Benchmark Results
- **Throughput**: ~192 workflows/sec (~578 jobs/sec)
- **Median Latency (P50)**: 22.7 ms
- **99th Percentile (P99)**: 62.7 ms
- **Success Rate**: 100% under concurrent DAG burst loads

---

## Verification & Testing

mini-ci features an exhaustive test suite covering unit, integration, failure injection, and chaos scenarios across both TypeScript and Python:

```bash
# Run all automated tests across TypeScript and Python
pnpm test:all

# Run TypeScript Vitest suites
pnpm test

# Run Python worker Pytest suites
pnpm test:worker

# Verify strict TypeScript type compliance (zero errors)
pnpm typecheck

# Build all production packages and Next.js dashboard
pnpm build
```

---

## Architecture Decision Records

Detailed engineering design choices are documented in `docs/adr/`:
- [ADR 001: PostgreSQL as Single Source of Truth](docs/adr/001-postgresql-single-source-of-truth.md)
- [ADR 002: Lease Fencing and Stale Worker Recovery](docs/adr/002-lease-fencing-and-recovery.md)
- [ADR 003: Distributed Directed Acyclic Graph (DAG) Scheduling](docs/adr/003-distributed-dag-scheduling.md)

---

## License

MIT
