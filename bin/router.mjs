#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readJSON, fetchRatings } from '../lib/ratings.mjs';
import { loadContext, saveJSON, backendCommand, withCatalog } from '../lib/config.mjs';
import { assessTask, scanProject } from '../lib/assess.mjs';
import { routeTask, normalizeCodexCatalog } from '../lib/route.mjs';
import { handleHook } from '../lib/hooks.mjs';
import { RpcProcess } from '../lib/rpc.mjs';
import { serveMcp } from '../lib/mcp.mjs';
import { CodexController } from '../lib/codex.mjs';
import { startProxy } from '../lib/proxy.mjs';
import { launchClaude } from '../lib/claude.mjs';
import { demoData } from '../examples/demo-data.mjs';

async function stdinJSON() { let data = ''; for await (const chunk of process.stdin) data += chunk; return JSON.parse(data); }
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    input: { type: 'string' }, output: { type: 'string' }, prompt: { type: 'string' }, project: { type: 'string' }
  } });
  const command = positionals[0] ?? 'help';
  if (command === 'help') { process.stdout.write('Difficulty Router (Node 22+)\n\nCommands:\n  demo                     Offline synthetic examples; never calls a model\n  assess --prompt TEXT     Difficulty and priority assessment only\n  models [--output FILE]   Read live Codex catalog metadata; no inference\n  ratings-refresh --output FILE  Refresh AA data using AA_API_KEY\n  route --input FILE      Recommend a model/effort/speed under CDR_CONFIG\n  dispatch --input FILE   Execute a verified independent Codex thread DAG\n  proxy                    JSONL Codex app-server transport with automatic routing\n  claude-launch --input FILE  Gated launch/resume for Claude Code\n  hook                     Plugin lifecycle input on stdin\n  mcp                      MCP stdio server\n'); return; }
  if (command === 'demo') {
    const context = demoData();
    print({ synthetic: true, modelCalls: 0, examples: ['Fix one spelling typo.', 'Investigate a cross-module refactor.', 'P0 production outage: diagnose an unknown concurrency failure.'].map(prompt => ({ prompt,
      route: routeTask({ ...context, assessment: assessTask({ prompt, project: context.project }) }) })) }); return;
  }
  if (command === 'hook') { print(await handleHook(await stdinJSON())); return; }
  if (command === 'mcp') { await serveMcp(); return; }
  if (command === 'proxy') { await startProxy(); return; }
  if (command === 'assess') { print(assessTask({ prompt: values.prompt, project: await scanProject(values.project ?? process.cwd()) })); return; }
  if (command === 'ratings-refresh') {
    if (!values.output) throw new Error('--output is required; leaderboard data stays in a private local file.');
    const snapshot = await fetchRatings(); await saveJSON(values.output, snapshot);
    print({ output: values.output, models: snapshot.models.length, indexVersion: snapshot.indexVersion }); return;
  }
  if (command === 'models') {
    const rpc = new RpcProcess(backendCommand());
    try {
      await rpc.initialize(); const catalog = normalizeCodexCatalog(await rpc.models());
      if (values.output) await saveJSON(values.output, catalog);
      print({ modelCalls: 0, catalog });
    } finally { rpc.close(); } return;
  }
  const request = values.input ? await readJSON(values.input) : await stdinJSON();
  const context = await loadContext();
  if (command === 'claude-launch') { process.exitCode = await launchClaude(request, context); return; }
  if (!['route', 'dispatch'].includes(command)) throw new Error(`Unknown command: ${command}`);
  let rpc;
  try {
    if (context.config.host === 'codex') { rpc = new RpcProcess(backendCommand()); await rpc.initialize(); }
    if (command === 'route') {
      const resolved = rpc ? await withCatalog(context, rpc) : context;
      print({ status: 'recommendation_only', ...routeTask({ ...resolved,
        assessment: assessTask({ prompt: request.prompt, project: await scanProject(values.project ?? process.cwd()), metadata: request.metadata }) }) });
    } else {
      if (!rpc) throw new Error('Independent thread dispatch requires the Codex adapter.');
      const receipt = await new CodexController(rpc).dispatch(request, context);
      print(receipt);
      if (receipt.status !== 'completed') process.exitCode = 2;
    }
  } finally { rpc?.close(); }
}
main().catch(error => { process.stderr.write(`${JSON.stringify({ code: error.code ?? 'ERROR', message: error.message, details: error.details })}\n`); process.exitCode = 1; });
