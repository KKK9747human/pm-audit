import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rememberBriefing, loadBriefHistory } from '../src/history.mjs';

const fixture = () => mkdtempSync(join(tmpdir(), 'pm-history-'));
const hash = (n) => `sha256:${String(n).padStart(64, '0')}`;
const bundle = (n) => ({ asOf: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`, hashes: { facts: hash(n), plan: hash(1000 + n) } });

test('brief-history 去重、只保留最近 100 条并原子落盘', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = bundle(1);
  assert.deepEqual(rememberBriefing(root, 'demo', first).map((r) => r.hash), [first.hashes.facts]);
  assert.equal(rememberBriefing(root, 'demo', first).length, 1, '同一指纹不得重复追加');
  for (let i = 2; i <= 101; i++) rememberBriefing(root, 'demo', bundle(i));
  const rows = loadBriefHistory(root, 'demo');
  assert.equal(rows.length, 100);
  assert.equal(rows[0].hash, hash(2));
  assert.equal(rows.at(-1).hash, hash(101));
  assert.deepEqual(readdirSync(join(root, 'data', 'demo')).filter((name) => name.endsWith('.tmp')), []);
});

test('brief-history 损坏时按空处理且不抛错', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'data', 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brief-history.json'), '{broken', 'utf8');
  assert.deepEqual(loadBriefHistory(root, 'demo'), []);
  assert.deepEqual(rememberBriefing(root, 'demo', bundle(1)).map((r) => r.hash), [hash(1)]);
});
