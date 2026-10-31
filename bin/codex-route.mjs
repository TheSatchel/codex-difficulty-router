#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { launchCodex } from '../lib/launcher.mjs';

const argv = process.argv.slice(2), separator = argv.indexOf('--');
const own = separator < 0 ? argv : argv.slice(0, separator);
const native = separator < 0 ? [] : argv.slice(separator + 1);
try {
  const { values, positionals } = parseArgs({ args: own, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, project: { type: 'string' }, model: { type: 'string' },
    'max-effort': { type: 'string' }, 'max-speed': { type: 'string' },
    'max-cost': { type: 'string' }, 'max-plan-cost': { type: 'string' }
  } });
  if (values.help) process.stdout.write(`codex-route [--project DIR] [--model ID] [--max-effort high] [--max-speed normal|fast|ultrafast] [-- NATIVE_CODEX_ARGS]\n\nStarts the native Codex terminal UI with real routing before each turn. Uses existing Codex login and permissions. All route records stay local; no routing text is appended to the model context.\nDefault upper bound: host-default rated model, highest measured effort, fastest advertised speed. Default planning budgets: 0.1 per task / 0.3 per child plan, in API-price-equivalent USD, not actual billing. Override with --max-cost / --max-plan-cost or CDR_CONFIG.\n`);
  else process.exitCode = await launchCodex({ project: values.project,
    profileOptions: { model: values.model, maxEffort: values['max-effort'], maxSpeed: values['max-speed'],
      ...(values['max-cost'] ? { maxCost: Number(values['max-cost']) } : {}),
      ...(values['max-plan-cost'] ? { maxPlanCost: Number(values['max-plan-cost']) } : {}) } }, [...positionals, ...native]);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code ?? 'LAUNCH_ERROR', message: error.message, details: error.details })}\n`);
  process.exitCode = 1;
}
