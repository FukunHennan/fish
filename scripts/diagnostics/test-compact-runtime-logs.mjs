import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'compact-runtime-logs.mjs');
const root = mkdtempSync(join(tmpdir(), 'fish-log-archive-'));
const runs = join(root, 'controller', 'diagnostics', 'runs');
const oldId = '20261008-151512-28676';
const activeId = '20261009-225352-14720';
const old = join(runs, oldId);
const active = join(runs, activeId);
const sample = Buffer.from('{"level":"ERROR","msg":"sample_failure"}\n', 'utf8');
function run(...args) {
  return spawnSync(process.execPath, [script, ...args, '--root', root], { encoding: 'utf8' });
}

try {
  mkdirSync(old, { recursive: true });
  mkdirSync(active, { recursive: true });
  writeFileSync(join(runs, 'LATEST.txt'), `${activeId}\n`);
  writeFileSync(join(old, 'controller.jsonl'), sample);
  writeFileSync(join(old, 'python-vision.txt'), 'camera check\r\n');
  writeFileSync(join(active, 'controller.jsonl'), 'still running\n');
  assert.equal(run('--check').status, 1, 'unarchived completed run must be rejected');
  assert.equal(run('--apply').status, 0);
  assert.equal(existsSync(old), false, 'completed raw run should be removed');
  assert.equal(existsSync(active), true, 'active raw run must remain');
  assert.equal(run('--check').status, 0);
  assert.equal(run('--apply').status, 0, 'repeated upload preparation should be idempotent');
  assert.equal(run('--restore', oldId).status, 0);
  assert.deepEqual(readFileSync(join(root, 'controller', 'diagnostics', 'restored', oldId, 'controller.jsonl')), sample);
  assert.equal(readFileSync(join(root, 'controller', 'diagnostics', 'restored', oldId, 'python-vision.txt'), 'utf8'), 'camera check\r\n');
  const archivePath = join(root, 'controller', 'diagnostics', 'archives', `${oldId}.json.gz`);
  writeFileSync(archivePath, Buffer.from('corrupt archive'));
  assert.equal(run('--check').status, 1, 'corrupted archive must be rejected');
  console.log('Diagnostic archive round-trip, active session, idempotence, and corruption checks passed.');
} finally {
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`), 'cleanup target must stay inside the temporary directory');
  rmSync(root, { recursive: true, force: true });
}
