import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFacts } from '../src/facts.mjs';
import { buildBundle, verifyBundle, saveBundle, loadBundle, VERSION } from '../src/bundle.mjs';
import { samplePlan, sampleProject, sampleRaw } from './lib/fixture.mjs';

function fixtureBundle() {
  const project = sampleProject();
  const raw = sampleRaw();
  const facts = buildFacts(samplePlan(), raw, project, raw.fetchedAt);
  return buildBundle(project, raw, facts);
}

test('buildBundle + verifyBundle 自洽', () => {
  const bundle = fixtureBundle();
  assert.equal(bundle.format, 'pm-audit/bundle');
  assert.equal(bundle.version, VERSION);
  assert.match(bundle.hashes.facts, /^sha256:[0-9a-f]{64}$/);
  const check = verifyBundle(bundle);
  assert.equal(check.ok, true);
  assert.equal(check.actual, bundle.hashes.facts);
});

test('facts 被篡改时 verifyBundle 拒绝', () => {
  const bundle = fixtureBundle();
  bundle.facts.nodes[1].state = 'done';
  const check = verifyBundle(bundle);
  assert.equal(check.ok, false);
});

test('project 配置被改动也会反映到重算结果', () => {
  const bundle = fixtureBundle();
  bundle.project.members = { ...bundle.project.members, m3: { name: 'Three', github: 'three' } };
  const check = verifyBundle(bundle);
  assert.equal(check.ok, false);
});

test('格式或版本不对直接抛错', () => {
  const bundle = fixtureBundle();
  assert.throws(() => verifyBundle({ ...bundle, format: 'other' }), /不是 pm-audit\/bundle/);
  assert.throws(() => verifyBundle({ ...bundle, version: VERSION + 1 }), /版本不支持/);
});

test('saveBundle / loadBundle 往返一致', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-bundle-'));
  try {
    const bundle = fixtureBundle();
    saveBundle(root, bundle);
    const loaded = loadBundle(root, 'demo');
    assert.ok(loaded);
    assert.equal(loaded.hashes.facts, bundle.hashes.facts);
    assert.equal(loadBundle(root, 'missing'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
