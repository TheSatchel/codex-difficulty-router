import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile), root = path.resolve(import.meta.dirname, '..');
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.router', 'coverage'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file)); else if (entry.isFile()) result.push(file);
  }
  return result;
}
const all = await files(root), json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
for (const file of all) {
  if (file.endsWith('.json')) JSON.parse(await readFile(file, 'utf8'));
  if (file.endsWith('.mjs')) await exec(process.execPath, ['--check', file]);
}
const pkg = await json('package.json');
assert.deepEqual(pkg.dependencies ?? {}, {});
assert.equal(Object.keys(pkg.scripts).some(key => /install|prepare|start/.test(key)), false);
for (const file of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
  const manifest = await json(file);
  assert.equal(manifest.name, pkg.name); assert.equal(manifest.version, pkg.version);
  assert.equal('hooks' in manifest || 'mcpServers' in manifest || 'extensions' in manifest, false);
}
for (const file of ['mcp.json', '.mcp.json', 'codex.mcp.json', 'hooks/hooks.json', 'hooks/codex-hooks.json']) {
  await assert.rejects(access(path.join(root, file)), { code: 'ENOENT' });
}
for (const file of all.filter(file => /\/(?:bin|lib)\//.test(file))) {
  const source = await readFile(file, 'utf8');
  assert.doesNotMatch(source, /child_process|launchctl|app-server|CODEX_APP_SERVER|LaunchAgent/);
}
const skill = await readFile(path.join(root, 'skills/difficulty-routing/SKILL.md'), 'utf8');
assert.match(skill, /^---\nname: difficulty-routing\ndescription: .+\n---\n/);
console.log(`Validated ${all.length} files: prompt-only manifests, no automatic runtime entrypoints, metadata data helpers, JSON and JavaScript syntax.`);
