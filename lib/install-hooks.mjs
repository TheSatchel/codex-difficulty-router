import path from 'node:path';
import os from 'node:os';
import { readFile, writeFile, mkdir, copyFile, rename, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { codexBinary } from './config.mjs';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export async function installCodexHooks({ codexDirectory = path.join(os.homedir(), '.codex'),
  codexCommand = [codexBinary()], nodePath = process.platform === 'darwin' && existsSync('/opt/homebrew/bin/node')
    ? '/opt/homebrew/bin/node' : process.execPath, version } = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version ?? '')) throw new Error('An exact reviewed plugin version is required.');
  const bridge = path.join(codexDirectory, 'bin', 'difficulty-router-hook.mjs');
  const file = path.join(codexDirectory, 'hooks.json');
  const source = `// Difficulty Router user-hook bridge. Never modifies hook trust.\n`
    + `import {execFileSync,spawnSync} from 'node:child_process';\nimport {readFileSync,existsSync} from 'node:fs';\nimport path from 'node:path';\n`
    + `const codex=${JSON.stringify(codexCommand)}, home=${JSON.stringify(codexDirectory)};\n`
    + `const input=readFileSync(0,'utf8'); const send=v=>{ if(v.hookSpecificOutput) { delete v.hookSpecificOutput.additionalContext; if(Object.keys(v.hookSpecificOutput).every(k=>k==='hookEventName')) delete v.hookSpecificOutput; } delete v.systemMessage; process.stdout.write(JSON.stringify(v)+'\\n'); };\n`
    + `try {\nconst result=JSON.parse(execFileSync(codex[0],[...codex.slice(1),'plugin','list','--marketplace','satchel-routing','--json'],{encoding:'utf8',timeout:2000,stdio:['ignore','pipe','pipe']}));\n`
    + `const entry=result.installed?.find(p=>p.pluginId==='codex-difficulty-router@satchel-routing'&&p.installed&&p.enabled);\n`
    + `if(!entry||entry.version!==process.argv[2]) { send({}); } else {\n`
    + `const script=path.join(home,'plugins','cache','satchel-routing','codex-difficulty-router',process.argv[2],'bin','router.mjs');\n`
    + `if(!existsSync(script)) send({}); else { const run=spawnSync(process.execPath,[script,'hook'],{input,encoding:'utf8',timeout:6000});\n`
    + `if(run.error||run.status!==0) send({systemMessage:'Difficulty Router hook could not run; review its installation.'});\n`
    + `else send(JSON.parse(run.stdout)); } }\n} catch { send({systemMessage:'Difficulty Router hook is inactive: plugin status could not be verified.'}); }\n`;
  await mkdir(path.dirname(bridge), { recursive: true, mode: 0o700 });
  await writeFile(bridge, source, { mode: 0o600 });
  let config = { hooks: {} }, backup = null;
  try {
    config = JSON.parse(await readFile(file, 'utf8'));
    const backupDirectory = path.join(codexDirectory, 'backups', `difficulty-router-hooks-${Date.now()}-${randomUUID().slice(0, 8)}`);
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    backup = path.join(backupDirectory, 'hooks.json'); await copyFile(file, backup);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  config.hooks ??= {};
  if (typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('Invalid existing hook registry; preserved without rewriting.');
  const command = `${quote(nodePath)} ${quote(bridge)} ${quote(version)}`;
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse']) {
    const groups = config.hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`Invalid existing ${event} hooks; registry preserved.`);
    config.hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.filter(handler =>
      !handler.command?.includes(bridge) && !handler.command?.includes(quote(bridge))) }))
      .filter(group => group.hooks.length);
    config.hooks[event].push({ hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'Difficulty Router' }] });
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
  await access(bridge);
  return { file, bridge, command, version, backup, events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse'],
    trust: 'User review required in Codex /hooks. No trust state was modified.' };
}
