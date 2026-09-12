# ADR 003: Distributed Directed Acyclic Graph (DAG) Scheduling

## Status
Accepted

## Context
Complex continuous integration pipelines require multi-job coordination with dependency topologies (e.g., `build` and `lint` run concurrently, followed by `test`, followed by `deploy`). In a distributed setting, different jobs in the same pipeline may execute on different worker machines according to capability tags and availability. The system must support DAG specification, cycle detection, topological validation, runtime dependency evaluation, and automatic failure propagation.

## Decision
We implement a two-stage DAG execution model:
1. Local runner topological resolution for standalone CLI workflows (`apps/runner`).
2. Distributed staged DAG scheduling within the database and scheduler (`apps/api` and `packages/scheduler`).

### 1. Specification and Cycle Detection
- Workflows define jobs via a dictionary with optional `needs` lists:
  ```yaml
  name: pipeline
  jobs:
    build:
      run: npm run build
    lint:
      run: npm run lint
    test:
      needs: [build]
      run: npm test
    deploy:
      needs: [test, lint]
      run: npm run deploy
  ```
- Parsers perform cycle detection using Kahn's algorithm / depth-first search. Cyclic dependencies or references to non-existent jobs are rejected at parse time.

### 2. Distributed Staging and Dynamic Promotion
- When a multi-job workflow is submitted to `POST /workflows/runs`:
  - All jobs are created in PostgreSQL with their `job_key` and `needs` array.
  - Root jobs (`needs: []`) are initialized in `queued` status and dispatched to Redis immediately.
  - Dependent jobs (`needs: [...]`) are initialized in `created` status.
- On each scheduler round (`Scheduler.scheduleRound()` / `POST /scheduler/tick`):
  - The scheduler inspects all `created` jobs.
  - A job is promoted to `queued` if and only if every upstream prerequisite job in `needs` is in `succeeded` status.
  - If any prerequisite job transitions to `failed`, `timed_out`, or `cancelled`, downstream jobs are not promoted, effectively pruning the failed execution branch.

## Consequences
### Positive
- Fully distributed execution: independent branches execute in parallel across separate physical workers.
- Resilience: failure in one branch does not deadlock the pipeline; downstream dependencies are reliably blocked while independent jobs finish.

### Negative
- Dependent jobs require a scheduler tick to transition from `created` to `queued` once prerequisites complete, introducing a sub-second scheduling latency between pipeline stages.
