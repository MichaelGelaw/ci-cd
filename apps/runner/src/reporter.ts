import type { WorkflowResult, StepResult } from '@mini-ci/types';

// ANSI color codes
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

function statusColor(status: string): string {
  switch (status) {
    case 'success': return GREEN;
    case 'failed': return RED;
    case 'skipped': return YELLOW;
    default: return RESET;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function printStep(step: StepResult): void {
  const color = statusColor(step.status);
  const status = step.status.toUpperCase();

  console.log(`  ${BOLD}${step.name}${RESET}`);
  console.log(`  ${DIM}$ ${step.command}${RESET}`);
  console.log(`  ${color}${status}${RESET} ${DIM}(${formatDuration(step.duration_ms)})${RESET}`);

  if (step.status === 'failed') {
    if (step.error) {
      console.log(`  ${RED}Error: ${step.error}${RESET}`);
    }
    if (step.stderr.trim()) {
      console.log(`  ${DIM}stderr: ${step.stderr.trim()}${RESET}`);
    }
  }

  console.log();
}

export function printResult(result: WorkflowResult): void {
  const color = statusColor(result.status);

  console.log();
  console.log(`${BOLD}Workflow: ${result.workflow_name}${RESET}`);
  console.log(`${DIM}${'-'.repeat(40)}${RESET}`);
  console.log();

  for (const step of result.steps) {
    printStep(step);
  }

  console.log(`${DIM}${'-'.repeat(40)}${RESET}`);
  console.log(
    `${BOLD}Result: ${color}${result.status.toUpperCase()}${RESET}` +
    `  ${DIM}(${formatDuration(result.duration_ms)})${RESET}`,
  );
  console.log();
}

export function printJson(result: WorkflowResult): void {
  console.log(JSON.stringify(result, null, 2));
}
