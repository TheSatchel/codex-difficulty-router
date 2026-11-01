import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = x => typeof x === 'string' && x.trim().length > 0;

export async function readCurrentMode({ threadId = process.env.CODEX_THREAD_ID,
  codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex'), expectedTurnId = process.env.CODEX_TURN_ID } = {}) {
  const unavailable = reason => ({ modelCalls: 0, status: 'unavailable', reason, mode: null });
  if (!text(threadId) || !uuid.test(threadId)) return unavailable('current-thread-id-unavailable');
  threadId = threadId.toLowerCase();
  const root = path.join(codexHome, 'sessions');
  const matches = [];
  async function walk(directory, depth = 0) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && depth < 3 && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
        await walk(path.join(directory, entry.name), depth + 1);
      } else if (entry.isFile() && depth === 3 && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${threadId}.jsonl`)) {
        matches.push(path.join(directory, entry.name));
      }
    }
  }
  try { await walk(root); } catch (error) { return unavailable(`session-directory-${error.code ?? 'unreadable'}`); }
  if (matches.length !== 1) return unavailable(matches.length ? 'ambiguous-session-files' : 'current-session-not-found');
  let sessionId, latest, started, ended, malformed = false, identityConflict = false;
  try {
    const lines = createInterface({ input: createReadStream(matches[0]), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { malformed = true; continue; }
      const d = r.payload ?? {};
      if (r.type === 'session_meta') {
        if (sessionId && sessionId !== d.id) identityConflict = true;
        sessionId = d.id;
      }
      if (r.type === 'turn_context') latest = { payload: d, timestamp: r.timestamp };
      if (r.type === 'event_msg' && d.type === 'task_started') { started = d.turn_id; ended = null; }
      if (r.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(d.type)) ended = d.turn_id ?? started;
    }
  } catch (error) { return unavailable(`session-read-${error.code ?? 'failed'}`); }
  if (malformed) return unavailable('incomplete-or-invalid-session-log');
  if (identityConflict || sessionId !== threadId) return unavailable('session-identity-mismatch');
  if (!latest) return unavailable('turn-context-not-found');
  const d = latest.payload;
  if (!text(started) || started !== d.turn_id || (expectedTurnId && expectedTurnId !== d.turn_id)) return unavailable('active-turn-context-pending');
  if (ended === d.turn_id) return unavailable('turn-no-longer-active');
  const effort = d.effort ?? d.reasoning_effort;
  if (!text(d.model) || !text(effort) || (d.effort && d.reasoning_effort && d.effort !== d.reasoning_effort)) return unavailable('exact-mode-missing-or-conflicting');
  const speed = { default: 'normal', priority: 'fast', ultrafast: 'ultrafast' }[d.service_tier];
  return { modelCalls: 0, status: 'resolved', mode: { model: d.model, effort, ...(speed ? { speed } : {}) },
    provenance: { source: 'active-thread-turn-context', threadId, turnId: d.turn_id, recordedAt: latest.timestamp, file: matches[0] },
    speedStatus: speed ? 'recorded' : 'not-recorded' };
}
