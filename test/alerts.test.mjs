import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlerts, alertCounts, nudgeText, renderAlerts } from '../src/alerts.mjs';

const node = (over) => ({
  id: 'X1', title: '任务', owner: 'A', done: false, state: 'ready',
  downstream: 0, onCriticalPath: false, daysIdle: null, prs: [], blockedBy: [],
  ...over,
});
const facts = (nodes) => ({ project: 'demo', asOf: '2026-11-20T00:00:00.000Z', nodes });

test('buildAlerts：停滞带 openPr、卡点点名前置负责人、待启动只挑卡下游的', () => {
  const f = facts([
    node({ id: 'S1', state: 'stale', daysIdle: 9, prs: [{ number: 5, state: 'open' }], downstream: 2 }),
    node({ id: 'B1', state: 'ready', downstream: 4, onCriticalPath: true }),
    node({ id: 'B2', state: 'blocked', blockedBy: ['B1'], downstream: 3 }),
    node({ id: 'R0', state: 'ready', downstream: 0, onCriticalPath: false }),
    node({ id: 'D1', state: 'done', done: true, downstream: 5 }),
  ]);
  const alerts = buildAlerts(f, { staleDays: 5 });
  const byId = Object.fromEntries(alerts.map((a) => [a.nodeId, a]));
  assert.equal(byId.S1.kind, 'stale');
  assert.equal(byId.S1.openPr, 5);
  assert.match(byId.S1.suggestion, /PR #5/);
  assert.equal(byId.B2.kind, 'blocked');
  assert.deepEqual(byId.B2.blockerOwners, ['A']);
  assert.match(byId.B2.suggestion, /先推 A 完成 B1/);
  assert.equal(byId.B1.kind, 'ready');
  assert.equal(byId.R0, undefined, '无下游非关键的待启动不催');
  assert.equal(byId.D1, undefined, '完成节点不催');
});

test('buildAlerts：关键路径 + 下游数决定优先级', () => {
  const f = facts([
    node({ id: 'LowReady', state: 'ready', downstream: 1 }),
    node({ id: 'CritReady', state: 'ready', downstream: 10, onCriticalPath: true }),
    node({ id: 'CritBlock', state: 'blocked', blockedBy: ['CritReady'], downstream: 9, onCriticalPath: true }),
  ]);
  const alerts = buildAlerts(f);
  assert.equal(alerts[0].nodeId, 'CritReady');
  assert.equal(alerts[1].nodeId, 'CritBlock');
  assert.equal(alerts[alerts.length - 1].nodeId, 'LowReady');
  assert.ok(alerts[0].priority > alerts[1].priority);
});

test('alertCounts 与 nudgeText', () => {
  const f = facts([
    node({ id: 'S1', state: 'stale', daysIdle: 7, owner: 'A' }),
    node({ id: 'B1', state: 'blocked', blockedBy: ['Z9'], owner: 'B', onCriticalPath: true }),
  ]);
  const alerts = buildAlerts(f);
  const c = alertCounts(alerts);
  assert.equal(c.total, 2);
  assert.equal(c.stale, 1);
  assert.equal(c.blocked, 1);
  assert.equal(c.critical, 1);
  const stale = alerts.find((a) => a.kind === 'stale');
  assert.match(nudgeText(stale), /@A S1.*停了 7 天/);
  const blocked = alerts.find((a) => a.kind === 'blocked');
  assert.match(nudgeText(blocked), /关键路径/);
});

test('renderAlerts：空清单与有清单都如实写，声明不自动发 GitHub', () => {
  const empty = renderAlerts(facts([]), [], { name: 'Demo' });
  assert.match(empty, /当前没有需要催办的节点/);
  assert.match(empty, /不会自动发到 GitHub/);
  const f = facts([node({ id: 'B1', state: 'ready', downstream: 4, onCriticalPath: true })]);
  const md = renderAlerts(f, buildAlerts(f), { name: 'Demo', hash: 'sha256:abcd1234' });
  assert.match(md, /催办清单/);
  assert.match(md, /★ 待启动 · B1/);
  assert.match(md, /下游 4/);
});