import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNextActions } from '../src/next-actions.mjs';
import { samplePlan, sampleProject, sampleRaw } from './lib/fixture.mjs';
import { buildFacts } from '../src/facts.mjs';

function facts() {
  return buildFacts(samplePlan(), sampleRaw(), sampleProject(), sampleRaw().fetchedAt);
}

function graphFacts(nodes) {
  const raw = {
    fetchedAt: '2026-02-01T00:00:00Z',
    repo: {}, issues: [], pulls: [], branches: [], branchCommits: [], pullDetails: {},
  };
  for (const n of nodes) {
    if (n.state === 'done') {
      raw.issues.push({ number: raw.issues.length + 1, state: 'closed', body: `<!-- pm:node=${n.id} -->` });
    } else if (n.state === 'active' || n.state === 'stale') {
      raw.branchCommits.push({
        name: `task/${n.id}`,
        commits: [{ sha: n.id, message: 'work', date: n.state === 'stale' ? '2026-01-14T00:00:00Z' : raw.fetchedAt }],
      });
    }
  }
  const plan = { project: 'Demo', nodes: nodes.map((n) => ({ title: `任务 ${n.id}`, owner: `owner-${n.id}`, est: 'S', deps: [], ...n })) };
  return buildFacts(plan, raw, sampleProject(), raw.fetchedAt);
}

function assertActionable(actions, f) {
  const byId = new Map(f.nodes.map((n) => [n.id, n]));
  assert.equal(new Set(actions.map((a) => a.nodeId)).size, actions.length);
  for (const a of actions) {
    const n = byId.get(a.nodeId);
    assert.ok(n, '行动必须指向真实节点');
    assert.notEqual(n.state, 'done');
    assert.notEqual(n.state, 'blocked');
    assert.ok(!n.done);
    assert.ok(n.deps.every((id) => byId.get(id)?.state === 'done'), '不能推荐仍有未完成前置的中间节点');
    assert.equal(a.title, n.title);
    assert.equal(a.owner, n.owner || null);
    assert.equal(a.onCriticalPath, n.onCriticalPath);
    for (const field of ['key', 'kind', 'kindLabel', 'reason', 'action']) assert.equal(typeof a[field], 'string');
    assert.equal(typeof a.priority, 'number');
    assert.equal(typeof a.downstream, 'number');
  }
}

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return Object.freeze(value);
}

test('最多三项，且不会重复展示同一节点', () => {
  const actions = buildNextActions(facts(), sampleProject(), 3);
  assert.ok(actions.length <= 3);
  assert.equal(new Set(actions.map((a) => a.nodeId)).size, actions.length);
});

test('多个后继被同一前置卡住时合并成一个行动项', () => {
  const plan = {
    project: 'Demo',
    nodes: [
      { id: 'R1', title: '根任务', owner: 'm1', est: 'M', deps: [] },
      { id: 'C1', title: '子一', owner: 'm2', est: 'S', deps: ['R1'] },
      { id: 'C2', title: '子二', owner: 'm2', est: 'S', deps: ['R1'] },
      { id: 'C3', title: '子三', owner: 'm2', est: 'S', deps: ['R1'] },
      { id: 'D1', title: '独立', owner: 'm2', est: 'S', deps: ['C1', 'C2', 'C3'] },
    ],
  };
  const raw = {
    repo: { full_name: 'acme/demo', pushed_at: '2026-01-10T00:00:00Z' },
    fetchedAt: '2026-01-10T00:00:00Z',
    issues: [],
    pulls: [],
    branches: [],
    branchCommits: [],
    pullDetails: {},
  };
  const f = buildFacts(plan, raw, sampleProject(), raw.fetchedAt);
  const actions = buildNextActions(f, sampleProject(), 3);
  const ready = actions.filter((a) => a.kind === 'ready' && a.nodeId === 'R1');
  assert.equal(ready.length, 1, '前置本身可启动时优先显示 ready，不重复做卡点');
  assert.deepEqual(actions.map((a) => a.nodeId), ['R1']);
  assert.equal(ready[0].downstream, 4);
});

test('停滞优先展示，且写明空闲天数与下游', () => {
  const plan = {
    project: 'Demo',
    nodes: [
      { id: 'S1', title: '停滞任务', owner: 'm1', est: 'M', deps: [] },
      { id: 'S2', title: '后继', owner: 'm2', est: 'S', deps: ['S1'] },
    ],
  };
  const raw = {
    repo: { full_name: 'acme/demo', pushed_at: '2026-02-01T00:00:00Z' },
    fetchedAt: '2026-02-01T00:00:00Z',
    issues: [],
    pulls: [],
    branches: [],
    branchCommits: [{ name: 'task/S1', commits: [{ sha: 's1', message: '[S1] work', date: '2026-01-14T00:00:00Z' }] }],
    pullDetails: {},
  };
  const f = buildFacts(plan, raw, sampleProject(), raw.fetchedAt);
  const actions = buildNextActions(f, sampleProject(), 3);
  const stale = actions.find((a) => a.nodeId === 'S1');
  assert.equal(stale.kind, 'stale');
  assert.match(stale.reason, /18 天没动静/);
  assert.match(stale.reason, /下游 1/);
});

test('没有行动项或没有数据时如实返回空', () => {
  assert.deepEqual(buildNextActions(null, {}), []);
  const plan = { project: 'Demo', nodes: [{ id: 'D1', title: '完成', owner: 'm1', est: 'S', deps: [] }] };
  const raw = {
    repo: { full_name: 'acme/demo', pushed_at: '2026-01-10T00:00:00Z' },
    fetchedAt: '2026-01-10T00:00:00Z',
    issues: [{ number: 1, state: 'closed', title: '[D1]', body: '<!-- pm:node=D1 -->', updated_at: '2026-01-10T00:00:00Z' }],
    pulls: [],
    branches: [],
    branchCommits: [],
    pullDetails: {},
  };
  const f = buildFacts(plan, raw, sampleProject(), raw.fetchedAt);
  assert.deepEqual(buildNextActions(f, sampleProject(), 3), []);
});

test('A1 -> A2 -> A3 只推荐可行动的 A1，身份与原因一致', () => {
  const f = graphFacts([
    { id: 'A1', state: 'active', title: '根接入', owner: 'root-owner' },
    { id: 'A2', deps: ['A1'], title: '中间实现', owner: 'middle-owner' },
    { id: 'A3', deps: ['A2'], title: '末端验收', owner: 'leaf-owner' },
  ]);
  const actions = buildNextActions(f);
  assert.deepEqual(actions.map((a) => a.nodeId), ['A1']);
  assertActionable(actions, f);
  const [root] = actions;
  assert.equal(root.kind, 'blocked-root');
  assert.equal(root.key, 'blocked:A1');
  assert.equal(root.owners, 'root-owner');
  assert.equal(root.downstream, 2);
  assert.deepEqual(new Set(root.nodeIds), new Set(['A2', 'A3']));
  assert.match(root.reason, /A1.*根接入/);
  assert.match(root.action, /root-owner.*A1/);
  assert.doesNotMatch(`${root.reason} ${root.action}`, /中间实现|末端验收|middle-owner|leaf-owner/);
});

test('菱形依赖按唯一未完成下游计数，不重复累计共享叶子', () => {
  const f = graphFacts([
    { id: 'A1', state: 'active' },
    { id: 'A2', deps: ['A1'] },
    { id: 'A3', deps: ['A1'] },
    { id: 'A4', deps: ['A2', 'A3'] },
    { id: 'A5', deps: ['A4'] },
    { id: 'A6', deps: ['A1'], state: 'done' },
  ]);
  const actions = buildNextActions(f);
  assert.deepEqual(actions.map((a) => a.nodeId), ['A1']);
  assertActionable(actions, f);
  assert.equal(actions[0].downstream, 4);
  assert.deepEqual(new Set(actions[0].nodeIds), new Set(['A2', 'A3', 'A4', 'A5']));
  assert.match(actions[0].reason, /下游 4/);
});

test('多个不同根分别给出自己的标题、负责人和行动，而非合并到第一个根', () => {
  const f = graphFacts([
    { id: 'R1', state: 'active', title: '接口', owner: 'alice' },
    { id: 'R2', state: 'active', title: '页面', owner: 'bob' },
    { id: 'C1', deps: ['R1', 'R2'], owner: 'carol' },
    { id: 'C2', deps: ['R1', 'C1'] },
  ]);
  const actions = buildNextActions(f);
  assert.deepEqual(new Set(actions.map((a) => a.nodeId)), new Set(['R1', 'R2']));
  assertActionable(actions, f);
  for (const a of actions) {
    const other = a.nodeId === 'R1' ? 'R2' : 'R1';
    assert.equal(a.downstream, 2);
    assert.equal(a.owners, a.owner);
    assert.ok(a.reason.includes(a.nodeId) && a.reason.includes(a.title));
    assert.ok(a.action.includes(a.nodeId) && a.action.includes(a.owner));
    assert.ok(!a.action.includes(other));
  }
});

for (const state of ['ready', 'stale']) {
  test(`多个层级共用 ${state} 根时保留原催办类型，只显示一次`, () => {
    const f = graphFacts([
      { id: 'R1', state },
      { id: 'C1', deps: ['R1'] },
      { id: 'C2', deps: ['R1'] },
      { id: 'C3', deps: ['C1', 'C2'] },
      { id: 'C4', deps: ['C3'] },
    ]);
    if (state === 'stale') f.nodes[0].prs = [{ number: 7, state: 'open' }];
    const actions = buildNextActions(f, { staleDays: 8 });
    assert.deepEqual(actions.map((a) => a.nodeId), ['R1']);
    assertActionable(actions, f);
    assert.equal(actions[0].kind, state);
    assert.equal(actions[0].downstream, 4);
    if (state === 'stale') {
      assert.match(actions[0].reason, /18 天没动静.*阈值 8 天/);
      assert.match(actions[0].action, /PR #7/);
    }
  });
}

test('停滞中间节点仍有未完成前置时不能作为可行动根', () => {
  const f = graphFacts([
    { id: 'A1', state: 'active' },
    { id: 'A2', state: 'stale', deps: ['A1'] },
    { id: 'A3', deps: ['A2'] },
  ]);
  const actions = buildNextActions(f);
  assert.deepEqual(actions.map((a) => a.nodeId), ['A1']);
  assertActionable(actions, f);
});

test('完成的依赖不会被推荐，也不阻止其未完成后继成为根', () => {
  const f = graphFacts([
    { id: 'A1', state: 'done' },
    { id: 'A2', state: 'active', deps: ['A1'] },
    { id: 'A3', deps: ['A2'] },
  ]);
  const actions = buildNextActions(f);
  assert.deepEqual(actions.map((a) => a.nodeId), ['A2']);
  assertActionable(actions, f);
  assert.equal(actions[0].downstream, 1);
  // The public state alone is also sufficient to identify a completed node.
  delete f.nodes[0].done;
  f.nodes[2].deps.push('A1');
  f.nodes[2].blockedBy.push('A1');
  assert.deepEqual(buildNextActions(f).map((a) => a.nodeId), ['A2']);
});

test('没有可行动数据、未知依赖或依赖环时不编造任务', () => {
  for (const f of [
    null,
    {},
    { nodes: [] },
    graphFacts([{ id: 'A1', state: 'done' }]),
    graphFacts([{ id: 'A1', state: 'active' }]),
    graphFacts([{ id: 'A1', deps: ['missing'] }]),
    graphFacts([{ id: 'A1', state: 'active', deps: ['missing'] }, { id: 'A2', deps: ['A1'] }]),
    graphFacts([{ id: 'A1', deps: ['A2'] }, { id: 'A2', deps: ['A1'] }]),
    { nodes: [{ id: 'A1', state: 'blocked', deps: [], blockedBy: [] }] },
  ]) assert.deepEqual(buildNextActions(f), []);
});

test('未知前置不阻止推荐其他已知可行动根，但不会生成虚构行动', () => {
  const f = graphFacts([
    { id: 'R1', state: 'active', owner: null },
    { id: 'C1', deps: ['missing', 'R1'] },
  ]);
  const actions = buildNextActions(f);
  assert.deepEqual(actions.map((a) => a.nodeId), ['R1']);
  assertActionable(actions, f);
  assert.equal(actions[0].owner, null);
  assert.equal(actions[0].downstream, 1);
  assert.doesNotMatch(actions[0].action, /missing|undefined|null/);
});

test('关键路径、停滞和下游优先级稳定，最多三项且尊重较小 limit', () => {
  const f = graphFacts([
    { id: 'A1', state: 'active' }, { id: 'A2', deps: ['A1'] },
    { id: 'B1', state: 'stale' }, { id: 'B2', deps: ['B1'] },
    { id: 'C1' }, { id: 'C2', deps: ['C1'] },
    { id: 'D1', state: 'active' }, { id: 'D2', deps: ['D1'] },
    { id: 'E1' }, { id: 'E2', deps: ['E1'] },
  ]);
  const actions = buildNextActions(f);
  assert.deepEqual(actions.map((a) => a.nodeId), ['A1', 'B1', 'C1']);
  assertActionable(actions, f);
  assert.deepEqual(actions.map((a) => a.kind), ['blocked-root', 'stale', 'ready']);
  assert.ok(actions[0].priority > actions[1].priority && actions[1].priority > actions[2].priority);
  assert.deepEqual(buildNextActions(f, {}, 10), actions);
  assert.deepEqual(buildNextActions(f, {}, 1), actions.slice(0, 1));
  assert.deepEqual(buildNextActions(f, {}, 0), []);
  assert.deepEqual(buildNextActions(f, {}, -1), []);
  const reversed = { ...f, nodes: [...f.nodes].reverse() };
  assert.deepEqual(buildNextActions(reversed), actions);
});

test('不修改 facts/config 或嵌套的依赖与 PR 证据', () => {
  const f = graphFacts([
    { id: 'R1', state: 'active' },
    { id: 'R2', state: 'stale' },
    { id: 'C1', deps: ['R2', 'R1'] },
    { id: 'C2', deps: ['C1'] },
  ]);
  const cfg = sampleProject();
  const before = structuredClone({ f, cfg });
  deepFreeze(f);
  deepFreeze(cfg);
  const actions = buildNextActions(f, cfg);
  assert.deepEqual({ f, cfg }, before);
  assertActionable(actions, f);
  assert.deepEqual(buildNextActions(f, cfg), actions);
});
