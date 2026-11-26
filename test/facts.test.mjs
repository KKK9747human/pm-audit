import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFacts } from '../src/facts.mjs';
import { samplePlan, sampleProject, sampleRaw } from './lib/fixture.mjs';

function facts() {
  const raw = sampleRaw();
  return buildFacts(samplePlan(), raw, sampleProject(), raw.fetchedAt);
}

function businessState(f) {
  return Object.fromEntries(f.nodes.map((n) => [n.id, { state: n.state, blockedBy: n.blockedBy }]));
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

test('节点状态不依赖计划数组顺序', () => {
  const normal = businessState(facts());
  const plan = samplePlan();
  const reordered = { ...plan, nodes: [...plan.nodes].reverse() };
  const raw = sampleRaw();
  const reversed = buildFacts(reordered, raw, sampleProject(), raw.fetchedAt);
  assert.deepEqual(businessState(reversed), normal);
});

test('有历史提交但无打开 PR 的节点长期未更新应判停滞', () => {
  const raw = sampleRaw();
  raw.pulls = raw.pulls.filter((p) => p.number !== 2);
  const f = buildFacts(samplePlan(), raw, sampleProject(), '2026-02-01T00:00:00Z');
  const a2 = f.nodes.find((n) => n.id === 'A2');
  assert.equal(a2.commits.length, 3);
  assert.equal(a2.daysIdle, 23);
  assert.equal(a2.state, 'stale');
});

test('停滞边界与已完成节点不误判', () => {
  const plan = {
    project: 'Demo',
    nodes: [
      { id: 'B1', title: '刚完成', owner: 'm1', est: 'S', deps: [] },
      { id: 'B2', title: '刚好停滞', owner: 'm1', est: 'S', deps: [] },
      { id: 'B3', title: '刚好活跃', owner: 'm1', est: 'S', deps: [] },
    ],
  };
  const raw = {
    repo: { full_name: 'acme/demo', pushed_at: '2026-01-20T00:00:00Z' },
    fetchedAt: '2026-01-20T00:00:00Z',
    issues: [
      { number: 1, state: 'closed', title: '[B1] 刚完成', body: '<!-- pm:node=B1 -->', updated_at: '2026-01-20T00:00:00Z' },
    ],
    pulls: [],
    branches: [],
    branchCommits: [
      { name: 'task/B2', commits: [{ sha: 'b2', message: '[B2] work', date: '2026-01-14T00:00:00Z' }] },
      { name: 'task/B3', commits: [{ sha: 'b3', message: '[B3] work', date: '2026-01-16T00:00:00Z' }] },
    ],
    pullDetails: {},
  };
  const f = buildFacts(plan, raw, sampleProject(), '2026-01-20T00:00:00Z');
  const byId = Object.fromEntries(f.nodes.map((n) => [n.id, n]));
  assert.equal(byId.B1.state, 'done');
  assert.equal(byId.B2.daysIdle, 6);
  assert.equal(byId.B3.daysIdle, 4);
  assert.equal(byId.B2.state, 'stale');
  assert.equal(byId.B3.state, 'active');
});
