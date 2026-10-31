import path from 'node:path';
import { configPath, dataDirectory, saveJSON, loadContext, applyCatalog } from './config.mjs';
import { sessionStatePath } from './codex.mjs';
import { assessTask, scanProject } from './assess.mjs';
import { assertWithinParent } from './route.mjs';
import { readJSON, requireValue } from './ratings.mjs';

const spawnTool = name => /(^|[_.])spawn_agent$|^(Agent|Task)$/.test(name);
const threadTool = name => /(^|[_.])(create_thread|fork_thread|send_message_to_thread)$/.test(name);
const denyTool = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

export function guardDelegation(event, state, context) {
  const tool = event.tool_name ?? '';
  if (threadTool(tool)) return denyTool('Use router_dispatch to check independent thread bounds, speed, cost and idempotency.');
  if (!spawnTool(tool)) return {};
  if (state?.mode?.effort !== 'ultra') return denyTool('Subagents are optional only at actual Ultra reasoning effort. Prefer independent threads.');
  try {
    requireValue(state.depth === 0, 'MAX_DECOMPOSITION_DEPTH', 'Child threads may not fan out.');
    const args = event.tool_input ?? {};
    const candidate = { model: args.model ?? state.mode.model,
      effort: args.reasoning_effort ?? args.effort ?? state.mode.effort, speed: args.speed ?? state.mode.speed };
    assertWithinParent(candidate, state.mode, { ...context, catalog: state.catalog });
    return {};
  } catch (error) { return denyTool(`${error.code ?? 'ROUTING_ERROR'}: ${error.message}`); }
}

export async function handleHook(event) {
  const name = event.hook_event_name;
  if (name === 'PreToolUse' && !spawnTool(event.tool_name ?? '') && !threadTool(event.tool_name ?? '')) return {};
  // Assessments belong to local telemetry, never to the model's prompt. In
  // particular, installing this plugin must not change an ordinary chat's text
  // or block it because it was not opened through the routing transport.
  if (name !== 'PreToolUse') {
    if (name === 'UserPromptSubmit') {
      try {
        await saveJSON(path.join(dataDirectory(), 'status', path.basename(sessionStatePath(event.session_id ?? 'unknown'))), {
          sessionId: event.session_id, source: 'hook-assessment', applied: false,
          assessment: assessTask({ prompt: event.prompt, project: await scanProject(event.cwd) }),
          observedAt: new Date().toISOString()
        });
      } catch { /* Telemetry failure never changes a user's prompt. */ }
    }
    return {};
  }
  try {
    let context = await loadContext(configPath(), { cacheOnly: true });
    let state;
    try { state = await readJSON(sessionStatePath(event.session_id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state?.catalog) context = applyCatalog(context, state.catalog);
    return guardDelegation(event, state, context);
  } catch (error) {
    if (error.code === 'ENOENT' && error.path === configPath()) return {};
    const reason = `Difficulty Router: ${error.code ?? 'ROUTING_ERROR'}: ${error.message}`;
    return denyTool(reason);
  }
}
