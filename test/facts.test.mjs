import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFacts } from '../src/facts.mjs';
import { samplePlan, sampleProject, sampleRaw } from './lib/fixture.mjs';

function facts() {
  const raw = sampleRaw();
  return buildFacts(samplePlan(), raw, sampleProject(), raw.fetchedAt);
}

test('节点状态：完成 / 进行中 / 阻塞 / 待启动', () => {
  const f = facts();
  const byId = Object.fromEntries(f.nodes.map((n) => [n.id, n]));
  assert.equal(byId.A1.state, 'done');
  assert.equal(byId.A2.state, 'active');
  assert.equal(byId.A3.state, 'blocked');
  assert.equal(byId.A4.state, 'ready');
  assert.deepEqual(byId.A3.blockedBy, ['A2']);
  assert.equal(f.stats.done, 1);
  assert.equal(f.stats.active, 1);
  assert.equal(f.stats.blocked, 1);
  assert.equal(f.stats.ready, 1);
});

test('叠分支的 base 历史不计入节点提交', () => {
  const f = facts();
  const a2 = f.nodes.find((n) => n.id === 'A2');
  const shas = a2.commits.map((c) => c.sha);
  assert.ok(!shas.includes('c1'), 'c1 是 main 上的 base 历史，不应挂在 A2');
  assert.deepEqual(shas, ['c3', 'c2']);
});

test('PR 的 pm:base 标记被解析出来', () => {
  const f = facts();
  const a2 = f.nodes.find((n) => n.id === 'A2');
  assert.equal(a2.prs[0].pm_base, 'sha256:abc');
});

test('关键路径按未完成子图最长链计算', () => {
  const f = facts();
  assert.deepEqual(f.criticalPath.path, ['A2', 'A3']);
  assert.equal(f.criticalPath.len, 11);
});

test('计划外提交单独列出', () => {
  const f = facts();
  assert.equal(f.unlinked.length, 1);
  assert.equal(f.unlinked[0].branch, 'main');
  assert.equal(f.unlinked[0].count, 1);
});

test('人维度统计已完成/剩余人日', () => {
  const f = facts();
  assert.equal(f.people.m1.total, 2);
  assert.equal(f.people.m1.done, 1);
  assert.equal(f.people.m1.remainingDays, 3);
});
