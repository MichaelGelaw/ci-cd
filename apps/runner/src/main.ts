import { resolve } from 'node:path';

import { parseWorkflowFile } from './parser.js';
import { executeWorkflow } from './executor.js';
import { printResult, printJson } from './reporter.js';

import type { ExecuteOptions } from './executor.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const forceShell = args.includes('--shell');
  const filePath = args.find((a) => !a.startsWith('--'));

  if (!filePath) {
    console.error('Usage: mini-ci <workflow.yml> [--json] [--shell]');
    process.exit(1);
  }

  const fullPath = resolve(filePath);

  let workflow;
  try {
    workflow = parseWorkflowFile(fullPath);
  } catch (error) {
    console.error(`Failed to parse workflow: ${(error as Error).message}`);
    process.exit(1);
  }

  const options: ExecuteOptions = {};
  if (forceShell) {
    options.mode = 'shell';
  }

  const result = await executeWorkflow(workflow, options);

  if (jsonMode) {
    printJson(result);
  } else {
    printResult(result);
  }

  process.exit(result.status === 'success' ? 0 : 1);
}

main();
