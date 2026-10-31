import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { saveJSON } from './config.mjs';
import { sessionStatePath, routingInstructions } from './codex.mjs';
import { scanProject, assessTask } from './assess.mjs';
import { routeTask } from './route.mjs';
import { readJSON, requireValue } from './ratings.mjs';

export function claudeArguments({ selected, prompt, sessionId, resume = false, pluginRoot }) {
  requireValue(['low', 'medium', 'high', 'xhigh', 'max'].includes(selected.effort), 'UNSUPPORTED_CLAUDE_EFFORT', 'This Claude adapter supports the efforts advertised by the verified CLI.');
  requireValue(['normal', 'fast'].includes(selected.speed), 'UNSUPPORTED_CLAUDE_SPEED', 'Claude Code has no verified ultrafast mapping.');
  return ['--model', selected.model, '--effort', selected.effort,
    '--settings', JSON.stringify({ fastMode: selected.speed === 'fast' }),
    '--plugin-dir', pluginRoot, resume ? '--resume' : '--session-id', sessionId, prompt];
}

export async function launchClaude(request, context) {
  requireValue(context.config.host === 'claude-code', 'HOST_MISMATCH', 'Use a Claude Code config with an explicitly verified catalog.');
  requireValue(!context.snapshot.synthetic, 'SYNTHETIC_RATINGS', 'Demo data never authorizes a Claude launch.');
  const cwd = process.env.CDR_PROJECT_ROOT ?? process.cwd();
  const sessionId = request.sessionId ?? randomUUID();
  requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId), 'INVALID_SESSION', 'Expected a UUID session id.');
  if (request.sessionId) {
    const prior = await readJSON(sessionStatePath(sessionId));
    requireValue(prior.host === 'claude-code' && prior.cwd === path.resolve(cwd), 'UNVERIFIED_SESSION', 'Only resume sessions created by this launcher in this workspace.');
  }
  const route = routeTask({ ...context, assessment: assessTask({ prompt: request.prompt, project: await scanProject(cwd), metadata: request.metadata }) });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = claudeArguments({ selected: route.selected, prompt: request.prompt, sessionId, resume: !!request.sessionId, pluginRoot: root });
  await saveJSON(sessionStatePath(sessionId), { host: 'claude-code', mode: route.selected, route,
    cwd: path.resolve(cwd), catalog: context.catalog, depth: 0, observedAt: new Date().toISOString() });
  process.stderr.write(`${JSON.stringify({ sessionId, selected: route.selected })}\n`);
  const child = spawn('claude', ['--append-system-prompt', routingInstructions(route), ...args], { cwd, stdio: 'inherit' });
  return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
}
