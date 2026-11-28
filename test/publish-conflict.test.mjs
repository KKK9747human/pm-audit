import test from 'node:test';
import assert from 'node:assert/strict';
import { isRefConflict, publishBaseConflict, planRemotePrune, isFullSha } from '../src/remote.mjs';

test('识别远端 ref 非快进冲突', () => {
  assert.equal(isRefConflict(new Error('gh PATCH repos/a/b/git/refs/heads/main 失败: HTTP 422: Update is not a fast forward')), true);
  assert.equal(isRefConflict(new Error('422 Unprocessable Entity')), true);
  assert.equal(isRefConflict(new Error('Reference update failed: already exists')), true);
});

test('普通网络错误不算冲突', () => {
  assert.equal(isRefConflict(new Error('dial tcp 140.82.121.6:443: connectex: connection attempt failed')), false);
  assert.equal(isRefConflict(new Error('HTTP 401: Bad credentials')), false);
  assert.equal(isRefConflict(null), false);
});

test('本机没有的远端解读不删除，其余陈旧文件仍删除', () => {
  const prefix = '.pm/demo/interpretations/';
  const remote = {
    '.pm/demo/manifest.json': 'h1',
    '.pm/demo/agent/tasks/A1.md': 'h2',
    [`${prefix}old.md`]: 'h3',
    '.pm/demo/leftover.md': 'h4',
  };
  const local = ['.pm/demo/manifest.json', '.pm/demo/agent/tasks/A1.md'];
  const { inherited, stale } = planRemotePrune(remote, local, prefix);
  assert.deepEqual(inherited, [`${prefix}old.md`]);
  assert.deepEqual(stale, ['.pm/demo/leftover.md']);
  assert.equal(planRemotePrune(remote, [...local, `${prefix}old.md`], prefix).inherited.length, 0);
  assert.deepEqual(planRemotePrune(null, local, prefix), { inherited: [], stale: [] });
});

test('远端进度更新时拒绝覆盖唯一数据包', () => {
  const local = { asOf: '2026-11-19T10:00:00.000Z', hashes: { facts: 'sha256:local' } };
  const newer = { asOf: '2026-11-19T12:00:00.000Z', hash: 'sha256:remote' };
  assert.match(publishBaseConflict(newer, local), /比本地.*新/);
  assert.equal(publishBaseConflict({ ...newer, asOf: '2026-11-19T09:00:00.000Z' }, local), null);
  assert.equal(publishBaseConflict({ ...newer, hash: 'sha256:local' }, local), null);
  assert.equal(publishBaseConflict(null, local), null);
  assert.equal(publishBaseConflict({ asOf: 'not-a-date', hash: 'sha256:remote' }, local), null);
});

test('发布快照只接受完整 SHA，拒绝短 SHA 或伪造引用', () => {
  assert.equal(isFullSha('a'.repeat(40)), true);
  assert.equal(isFullSha('A'.repeat(40)), true);
  assert.equal(isFullSha('a'.repeat(39)), false);
  assert.equal(isFullSha('g'.repeat(40)), false);
  assert.equal(isFullSha(null), false);
});
