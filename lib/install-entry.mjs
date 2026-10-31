import path from 'node:path';
import os from 'node:os';
import { readFile, mkdir, writeFile, chmod, copyFile, access, lstat, readlink, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { codexBinary, dataDirectory } from './config.mjs';

const exec = promisify(execFile);
export async function installCodexEntry({ codexDirectory = path.join(os.homedir(), '.codex'),
  runtimeDirectory = path.join(dataDirectory(), 'runtime'), command = codexBinary(),
  linkDirectory = process.platform === 'darwin' && process.env.PATH?.split(path.delimiter).includes('/opt/homebrew/bin')
    ? '/opt/homebrew/bin' : null } = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const lock = await readFile(path.join(root, 'package-lock.json'));
  const runtime = path.join(runtimeDirectory, createHash('sha256').update(lock).digest('hex').slice(0, 16));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await copyFile(path.join(root, 'package.json'), path.join(runtime, 'package.json'));
  await copyFile(path.join(root, 'package-lock.json'), path.join(runtime, 'package-lock.json'));
  await exec('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: runtime, timeout: 120_000 });
  const file = path.join(codexDirectory, 'bin', 'codex-route');
  const marker = '// Difficulty Router native Codex entry.';
  try {
    const existing = await readFile(file, 'utf8');
    if (!existing.includes(marker)) throw new Error(`Existing command is not owned by Difficulty Router: ${file}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = `#!/usr/bin/env node\n${marker}\n`
    + `import {execFileSync,spawn} from 'node:child_process';\nimport {existsSync} from 'node:fs';\nimport path from 'node:path';\n`
    + `const command=${JSON.stringify(command)}, home=${JSON.stringify(codexDirectory)}, runtime=${JSON.stringify(runtime)};\n`
    + `try {\nconst result=JSON.parse(execFileSync(command,['plugin','list','--marketplace','satchel-routing','--json'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}));\n`
    + `const plugin=result.installed?.find(p=>p.pluginId==='codex-difficulty-router@satchel-routing'&&p.installed&&p.enabled);\n`
    + `if(!plugin||!/^\\d+\\.\\d+\\.\\d+(?:-[a-zA-Z0-9.-]+)?$/.test(plugin.version)) throw new Error('Install and enable codex-difficulty-router@satchel-routing first.');\n`
    + `const entry=path.join(home,'plugins','cache','satchel-routing','codex-difficulty-router',plugin.version,'bin','codex-route.mjs');\n`
    + `if(!existsSync(entry)) throw new Error('Upgrade Difficulty Router to 0.3.0 or later.');\n`
    + `const child=spawn(process.execPath,[entry,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,CDR_RUNTIME_ROOT:runtime}});\n`
    + `child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});\n`
    + `} catch(error) {console.error(error.message);process.exitCode=1;}\n`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, source, { mode: 0o755 }); await chmod(file, 0o755);
  let link = null;
  if (linkDirectory) {
    const candidate = path.join(linkDirectory, 'codex-route');
    try {
      const existing = await lstat(candidate);
      if (existing.isSymbolicLink() && await readlink(candidate) === file) link = candidate;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await access(linkDirectory); await symlink(file, candidate); link = candidate; }
      catch (linkError) { if (!['EACCES', 'EPERM', 'ENOENT'].includes(linkError.code)) throw linkError; }
    }
  }
  return { file, link, runtime, cacheModified: false, globalConfigModified: false };
}
