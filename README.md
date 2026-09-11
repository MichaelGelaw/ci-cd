# mini-ci

A miniature CI/CD platform that executes workflows across distributed workers with job scheduling, container isolation, failure recovery, and live log streaming.

## Current State

**Milestone 1: Local Command Runner**

The system currently supports local sequential command execution. It parses YAML workflow definitions and runs each step as a child process, capturing output, exit codes, and timing.

## Quick Start

```bash
npm install
npx tsx apps/runner/src/main.ts workflows/examples/hello.yml
```

### Example Workflow

```yaml
name: hello

steps:
  - run: echo "hello world"
  - run: python --version
  - run: echo "done"
```

### Example Output

```
Workflow: hello
----------------------------------------

  Step 1
  $ echo "hello world"
  SUCCESS (12ms)

  Step 2
  $ python --version
  SUCCESS (45ms)

  Step 3
  $ echo "done"
  SUCCESS (8ms)

----------------------------------------
Result: SUCCESS  (65ms)
```

### JSON Output

```bash
npx tsx apps/runner/src/main.ts workflows/examples/hello.yml --json
```

Produces a structured JSON result with per-step exit codes, stdout, stderr, and timing.

### Failure Handling

When a step fails (non-zero exit code), remaining steps are skipped:

```bash
npx tsx apps/runner/src/main.ts workflows/examples/failing.yml
```

### Timeouts

Steps can specify a `timeout_seconds` field. If the step exceeds its timeout, the process is killed:

```bash
npx tsx apps/runner/src/main.ts workflows/examples/timeout.yml
```

## Running Tests

```bash
npm test
```

## Project Structure

```
mini-ci/
  apps/
    runner/          Local command runner
      src/
        main.ts      CLI entry point
        parser.ts    YAML workflow parser
        executor.ts  Sequential command executor
        reporter.ts  Console and JSON output
      tests/
  packages/
    types/           Shared TypeScript type definitions
  workflows/
    examples/        Example workflow files
  docs/              Architecture and design docs
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full system design and milestone roadmap.

## License

MIT
