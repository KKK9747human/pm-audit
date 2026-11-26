import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFacts } from '../src/facts.mjs';
import { hashOf } from '../src/canonical.mjs';
import { buildBundle, verifyBundle, saveBundle, loadBundle, VERSION } from '../src/bundle.mjs';
import { renderAudit } from '../src/render.mjs';
import { samplePlan, sampleProject, sampleRaw } from './lib/fixture.mjs';

function fixtureBundle() {
  const project = sampleProject();
  const raw = sampleRaw();
  const facts = buildFacts(samplePlan(), raw, project, raw.fetchedAt);
  return buildBundle(project, raw, facts);
}

// 两条计划外分支：分支名靠前但提交少，靠后但提交多。渲染排序不能回头改 facts 数组顺序。
function unlinkedBundle() {
  const project = sampleProject();
  const raw = sampleRaw();
  raw.branchCommits.push({
    name: 'zz-unlinked',
    commits: [
      { sha: 'd'.repeat(40), message: 'unlinked one', date: raw.fetchedAt },
      { sha: 'e'.repeat(40), message: 'unlinked two', date: raw.fetchedAt },
    ],
  });
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

test('渲染审计报告不修改事实数组，渲染后指纹仍自洽', () => {
  const bundle = unlinkedBundle();
  const before = hashOf(bundle);
  assert.equal(verifyBundle(bundle).ok, true);
  assert.deepEqual(bundle.facts.unlinked.map((u) => u.branch), ['main', 'zz-unlinked']);
  const report = renderAudit(bundle.facts, bundle.project, bundle.project.planSource);
  assert.equal(verifyBundle(bundle).ok, true);
  assert.equal(hashOf(bundle), before, '渲染不得改变包内事实顺序或内容');
  assert.deepEqual(bundle.facts.unlinked.map((u) => u.branch), ['main', 'zz-unlinked']);
  assert.match(report, /计划外提交/);
  assert.ok(report.indexOf('zz-unlinked') < report.indexOf('`main`'), '报告仍按提交数量把 zz-unlinked 排在 main 前');
});

test('渲染审计报告不容忍输入被冻结时报错', () => {
  const bundle = unlinkedBundle();
  Object.freeze(bundle.facts.unlinked);
  Object.freeze(bundle.facts.unlinked.map((u) => Object.freeze(u)));
  const report = renderAudit(bundle.facts, bundle.project, bundle.project.planSource);
  assert.match(report, /zz-unlinked/);
});

test('渲染审计报告容忍空计划外提交', () => {
  const bundle = fixtureBundle();
  bundle.facts.unlinked = [];
  const report = renderAudit(bundle.facts, bundle.project, bundle.project.planSource);
  assert.match(report, /## 四、卡点/);
  assert.deepEqual(bundle.facts.unlinked, []);
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

test('旧版本提示重新审计，不冒充指纹篡改', () => {
  const bundle = fixtureBundle();
  const legacy = { ...bundle, version: VERSION - 1 };
  assert.throws(() => verifyBundle(legacy), /已过期/);
  try {
    verifyBundle(legacy);
  } catch (err) {
    assert.equal(err.code, 'LEGACY_BUNDLE');
  }
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
