import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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
