import { createInterface } from 'node:readline';
import { loadContext, backendCommand, withCatalog, configuredCache } from './config.mjs';
import { RpcProcess } from './rpc.mjs';
import { CodexController } from './codex.mjs';
import { assessTask, scanProject } from './assess.mjs';
import { routeTask } from './route.mjs';
import { requireValue } from './ratings.mjs';
import { cacheSummary } from './ratings-cache.mjs';

const taskSchema = {
  type: 'object', required: ['id', 'prompt', 'acceptance', 'readOnly'], additionalProperties: false,
  properties: { id: { type: 'string' }, prompt: { type: 'string' }, acceptance: { type: 'string' },
    readOnly: { type: 'boolean' }, writePaths: { type: 'array', items: { type: 'string' } },
    dependsOn: { type: 'array', items: { type: 'string' } },
    metadata: { type: 'object', properties: { difficulty: { enum: ['simple', 'standard', 'complex', 'expert'] },
      priority: { enum: ['background', 'normal', 'high', 'urgent'] }, speed: { enum: ['normal', 'fast', 'ultrafast'] } }, additionalProperties: false }
  }
};

export const TOOLS = [
  { name: 'router_cache', description: 'Cache the complete public Artificial Analysis model dataset: every vendor, variant, retired model, score, price, speed and benchmark field. Refresh online when due and keep a valid offline copy. No API key or model invocation.',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean' } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  { name: 'router_assess', description: 'Assess task difficulty, uncertainty and priority from the task and current project metadata. No model invocation.',
    inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'router_route', description: 'Recommend a rated model/effort/speed within the configured ceiling and price budget. This does not switch the active chat.',
    inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  { name: 'router_dispatch', description: 'Create independent persistent Codex threads for a bounded task DAG, wait for results, and return them for main-chat integration. Requires autoThreads enabled in the user-owned routing config.',
    inputSchema: { type: 'object', required: ['requestId', 'parentThreadId', 'tasks'], additionalProperties: false,
      properties: { requestId: { type: 'string' }, parentThreadId: { type: 'string' }, tasks: { type: 'array', minItems: 1, maxItems: 16, items: taskSchema } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
];

export async function callTool(name, args) {
  if (name === 'router_cache') return { modelCalls: 0, ...cacheSummary(await configuredCache({}, { force: args.force === true })) };
  if (name === 'router_assess') return assessTask({ prompt: args.prompt, project: await scanProject(process.env.CDR_PROJECT_ROOT ?? process.cwd()) });
  const context = await loadContext();
  let rpc;
  try {
    if (context.config.host === 'codex') { rpc = new RpcProcess(backendCommand()); await rpc.initialize(); }
    if (name === 'router_route') {
      const resolved = rpc ? await withCatalog(context, rpc) : context;
      const assessment = assessTask({ prompt: args.prompt, project: await scanProject(process.env.CDR_PROJECT_ROOT ?? process.cwd()) });
      return { status: 'recommendation_only', ...routeTask({ ...resolved, assessment }) };
    }
    if (name === 'router_dispatch') {
      requireValue(rpc, 'UNSUPPORTED_HOST', 'Automatic independent thread dispatch is implemented for Codex. Claude Code currently supports assessment, gated launch and policy hooks.');
      return await new CodexController(rpc).dispatch(args, context);
    }
    throw new Error(`Unknown tool: ${name}`);
  } finally { rpc?.close(); }
}

export async function serveMcp({ input = process.stdin, output = process.stdout } = {}) {
  const send = message => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  async function handle(message) {
    if (message.id === undefined) return;
    try {
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codex-difficulty-router', version: '0.2.0' } };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/list') result = { tools: TOOLS };
      else if (message.method === 'tools/call') {
        try {
          const tool = TOOLS.find(t => t.name === message.params?.name);
          requireValue(tool, 'UNKNOWN_TOOL', 'Unknown routing tool.');
          const args = message.params.arguments ?? {};
          requireValue((tool.inputSchema.required ?? []).every(key => args[key] !== undefined), 'INVALID_ARGUMENTS', 'Missing required tool arguments.');
          const value = await callTool(tool.name, args);
          result = { content: [{ type: 'text', text: JSON.stringify(value) }], isError: value.status === 'needs_attention' };
        } catch (error) { result = { content: [{ type: 'text', text: JSON.stringify({ code: error.code ?? 'TOOL_ERROR', message: error.message, details: error.details }) }], isError: true }; }
      } else { send({ id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
      send({ id: message.id, result });
    } catch (error) { send({ id: message.id, error: { code: -32603, message: error.message } }); }
  }
  const jobs = new Set();
  for await (const line of createInterface({ input })) {
    let message;
    try { message = JSON.parse(line); }
    catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
    const job = handle(message); jobs.add(job); job.finally(() => jobs.delete(job));
  }
  await Promise.allSettled(jobs);
}
