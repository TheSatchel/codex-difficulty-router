import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const root = path.resolve(import.meta.dirname, '..');
test('data helper refuses an implicit global cache before contacting the network', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'bin/router-data.mjs'), 'cache'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, 'EXPLICIT_CACHE_REQUIRED');
});

test('data helper cannot launch, proxy or install a Codex runtime', () => {
  for (const command of ['proxy', 'mcp', 'dispatch', 'desktop-install']) {
    const result = spawnSync(process.execPath, [path.join(root, 'bin/router-data.mjs'), command], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).code, 'UNKNOWN_COMMAND');
  }
});

test('prompt requires a real switch acknowledgment and forbids the withdrawn integration', async () => {
  const prompt = await readFile(path.join(root, 'skills/difficulty-routing/SKILL.md'), 'utf8');
  assert.match(prompt, /主动调用它并回读确认/);
  assert.match(prompt, /尚未切换/);
  assert.match(prompt, /LaunchAgent、daemon、后台服务、MCP server、用户级 hook/);
  assert.match(prompt, /实际为 `ultra`/);
  assert.match(prompt, /普通持久化 thread/);
});
