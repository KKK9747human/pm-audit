import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDraft, buildDraftMessages, buildPlanMessages, draftPlan, gatherSources } from '../src/plandraft.mjs';
import { validatePlan } from '../src/project.mjs';

test('parseDraft：剥围栏、剥解释文字，补齐 deps/files', () => {
  const plan = parseDraft('好的，计划如下：\n```json\n{"project":"x","nodes":[{"id":"A1","title":"t","est":"M"}]}\n```\n以上。');
  assert.equal(plan.nodes.length, 1);
  assert.deepEqual(plan.nodes[0].deps, []);
  assert.deepEqual(plan.nodes[0].files, []);
  assert.throws(() => parseDraft('没有 json'), /没有 JSON 对象/);
  assert.throws(() => parseDraft('{"nodes":{}}'), /缺 nodes 数组/);
});

test('parseDraft 产物能过正式计划校验，坏依赖会被拦', () => {
  const good = parseDraft('{"nodes":[{"id":"A1","title":"t","est":"S","deps":[]},{"id":"A2","title":"u","est":"M","deps":["A1"]}]}');
  assert.equal(validatePlan(good).nodes, 2);
  const bad = parseDraft('{"nodes":[{"id":"A1","title":"t","deps":["A9"]}]}');
  assert.throws(() => validatePlan(bad), /依赖不存在的 A9/);
});

test('parseDraft：owner 为 null/非字符串时丢弃，无成员草稿也能过校验', () => {
  const plan = parseDraft('{"nodes":[{"id":"A1","title":"t","owner":null},{"id":"A2","title":"u","owner":123},{"id":"A3","title":"v","owner":"A"}]}');
  assert.equal(plan.nodes[0].owner, undefined);
  assert.equal(plan.nodes[1].owner, undefined);
  assert.equal(plan.nodes[2].owner, 'A');
  assert.equal(validatePlan(plan).nodes, 3);
});

test('buildDraftMessages：成员归属约束与空成员指引', () => {
  const src = { docs: [{ path: 'README.md', text: '分工：A 负责采集' }], issues: [{ number: 1, title: '[A1] x', state: 'open', body: '' }] };
  const withMembers = buildDraftMessages(src, { A: { name: '甲' } });
  assert.match(withMembers[1].content, /owner 只能填这些代号/);
  assert.match(withMembers[1].content, /README\.md/);
  const noMembers = buildDraftMessages(src, null);
  assert.match(noMembers[1].content, /owner 填 null/);
  assert.match(withMembers[0].content, /不许有环/);
});

test('gatherSources：本地文档按分工优先、限长限篇，issue 走缓存不碰网络', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-plandraft-'));
  const root = mkdtempSync(join(tmpdir(), 'pm-plandraft-root-'));
  try {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'README.md'), 'r'.repeat(9000));
    writeFileSync(join(dir, 'docs', 'zzz.md'), '普通文档');
    writeFileSync(join(dir, 'docs', '团队分工与里程碑.md'), '分工文档');
    for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(dir, 'docs', `${n}.md`), n);
    mkdirSync(join(root, 'cache', 'demo'), { recursive: true });
    writeFileSync(join(root, 'cache', 'demo', 'raw.json'), JSON.stringify({ issues: [{ number: 1, title: 't', state: 'open', is_pr: false, body: 'b' }] }));
    const s = await gatherSources(root, { repo: 'o/r', localRepo: dir, id: 'demo' });
    assert.equal(s.docs[0].path, 'README.md');
    assert.equal(s.docs[0].text.length, 6000);
    assert.equal(s.docs[1].path, 'docs/团队分工与里程碑.md');
    assert.ok(s.docs.length <= 5);
    assert.equal(s.issues.length, 1);
    assert.equal(s.issues[0].number, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildPlanMessages：立项上下文进入提示词并保留旧兼容行为', () => {
  const sources = { docs: [{ path: 'README.md', text: 'README' }], issues: [] };
  const old = buildDraftMessages(sources, null);
  assert.doesNotMatch(old.map((m) => m.content).join('\n'), /立项调研草稿/);
  const next = buildPlanMessages(
    sources,
    { m1: { name: '甲' } },
    { brief: { idea: '想法', nonGoals: ['不做 A'] }, researchMarkdown: '# 调研\n事实：X' },
  );
  const text = next.map((m) => m.content).join('\n');
  assert.match(text, /立项卡/);
  assert.match(text, /不做 A/);
  assert.match(text, /立项调研草稿（人工可编辑）/);
  assert.match(text, /假设与待验证项不得当成既定事实/);
  assert.match(text, /owner 只能填这些代号/);
});

test('draftPlan：第一版不合格时复用同一消息链重试', async () => {
  let calls = 0;
  const completeFn = async () => {
    calls += 1;
    return calls === 1 ? '{"nodes":[]}' : '{"project":"P","nodes":[{"id":"A1","title":"好","est":"S"}]}';
  };
  const r = await draftPlan('', {
    sources: { docs: [], issues: [] },
    members: null,
    completeFn,
  });
  assert.equal(calls, 2);
  assert.equal(r.attempts, 2);
  assert.equal(r.plan.nodes[0].title, '好');
});