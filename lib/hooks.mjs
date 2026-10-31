import { configPath, loadContext } from './config.mjs';
import { sessionStatePath, routingInstructions } from './codex.mjs';
import { assessTask, scanProject } from './assess.mjs';
import { routeTask, assertWithinParent } from './route.mjs';
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
  try {
    const context = await loadContext(configPath());
    let state;
    try { state = await readJSON(sessionStatePath(event.session_id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (name === 'PreToolUse') return guardDelegation(event, state, context);
    if (name === 'SessionStart') return {
      hookSpecificOutput: { hookEventName: name, additionalContext: 'Difficulty Router is enabled. Codex transport routing applies at turn boundaries. Use router_assess / router_dispatch; independent threads are preferred. Subagents require actual Ultra effort. Normal/fast/ultrafast are speed tiers, separate from effort. No rating/price evidence means no automatic model selection.' }
    };
    if (name === 'UserPromptSubmit') {
      requireValue(state?.mode && state?.catalog?.length && state?.route, 'UNVERIFIED_SESSION_MODE',
        'Start this session through the Codex routing proxy or Claude launcher. A plain hook cannot change or verify the active model, effort and speed.');
      requireValue(state.host === context.config.host, 'HOST_MISMATCH', 'Session and routing config use different hosts.');
      requireValue(!event.model || event.model === state.mode.model, 'SESSION_MODE_CHANGED', 'Model changed outside the router; re-enter through the adapter.');
      const assessment = assessTask({ prompt: event.prompt, project: await scanProject(event.cwd) });
      // Hooks enforce the actual active mode. Recommendations never pretend to
      // have switched an in-flight model or to have changed the desktop UI.
      const route = routeTask({ ...context, catalog: state.catalog, assessment, parent: state.mode });
      assertWithinParent(state.mode, context.config.ceiling, { ...context, catalog: state.catalog });
      return { hookSpecificOutput: { hookEventName: name, additionalContext: routingInstructions({ ...route, selected: state.mode }, { child: state.depth > 0 }) } };
    }
    return {};
  } catch (error) {
    const reason = `Difficulty Router: ${error.code ?? 'ROUTING_ERROR'}: ${error.message}`;
    if (name === 'PreToolUse') return denyTool(reason);
    if (name === 'UserPromptSubmit') return { decision: 'block', reason };
    return { systemMessage: reason };
  }
}
