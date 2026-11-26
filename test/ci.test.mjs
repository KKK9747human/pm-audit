import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCheckRun, summarizeChecks } from '../src/ci.mjs';

const head = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);

test('mapCheckRun 保留来源信息，不把未知字段补成成功', () => {
  const mapped = mapCheckRun({
    id: 7,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    head_sha: head,
    html_url: 'https://github.com/acme/demo/runs/7',
    started_at: '2026-11-20T00:00:00Z',
    completed_at: '2026-11-20T00:05:00Z',
  });
  assert.equal(mapped.id, 7);
  assert.equal(mapped.head_sha, head);
  assert.equal(mapped.url, 'https://github.com/acme/demo/runs/7');
  assert.equal(mapCheckRun(null), null);
});

test('CI 全部成功且来源匹配才是 passed', () => {
  const result = summarizeChecks({
    runs: [
      { name: 'build', status: 'completed', conclusion: 'success', head_sha: head },
      { name: 'test', status: 'completed', conclusion: 'success', head_sha: head },
    ],
    headSha: head,
    complete: true,
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.reason, '已采集的 CI 检查全部成功');
});

test('失败优先展示，即使采集不完整也不冒充全部失败或全部通过', () => {
  const result = summarizeChecks({
    runs: [
      { name: 'build', status: 'completed', conclusion: 'failure', head_sha: head },
      { name: 'test', status: 'completed', conclusion: 'success', head_sha: head },
    ],
    headSha: head,
    complete: false,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.complete, false);
});

test('未完成是 pending，空列表、旧 SHA、截断都是 unknown', () => {
  assert.equal(summarizeChecks({ runs: [{ name: 'build', status: 'in_progress', conclusion: null, head_sha: head }], headSha: head }).status, 'pending');
  assert.equal(summarizeChecks({ runs: [], headSha: head }).status, 'unknown');
  assert.equal(summarizeChecks({ runs: [{ name: 'build', status: 'completed', conclusion: 'success', head_sha: oldHead }], headSha: head }).status, 'unknown');
  assert.equal(
    summarizeChecks({ runs: [{ name: 'build', status: 'completed', conclusion: 'success', head_sha: head }], headSha: head, complete: false, truncated: true }).status,
    'unknown',
  );
});

test('neutral/skipped 不算通过，但采集可以完整', () => {
  const result = summarizeChecks({
    runs: [
      { name: 'lint', status: 'completed', conclusion: 'neutral', head_sha: head },
      { name: 'docs', status: 'completed', conclusion: 'skipped', head_sha: head },
    ],
    headSha: head,
    complete: true,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.equal(result.collectionReason, null);
});

const success = (overrides = {}) => ({
  id: 1, name: 'build', status: 'completed', conclusion: 'success', head_sha: head, ...overrides,
});

for (const headSha of [undefined, null, '', 'a'.repeat(8), 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), 123]) {
  test(`expected head must be a full 40-hex SHA: ${String(headSha)}`, () => {
    const result = summarizeChecks({ runs: [success()], headSha, complete: true });
    assert.equal(result.status, 'unknown');
    assert.equal(result.complete, false);
    assert.equal(result.truncated, false);
    assert.match(result.reason, /head.*40|40.*head/i);
  });
}

for (const head_sha of [null, '', 'a'.repeat(8), oldHead]) {
  test(`every run must match the expected head: ${String(head_sha)}`, () => {
    const result = summarizeChecks({
      runs: [success({ conclusion: 'failure' }), success({ id: 2, head_sha })],
      headSha: head,
      complete: true,
    });
    assert.equal(result.status, 'unknown');
    assert.equal(result.complete, false);
    assert.match(result.reason, /head/);
  });
}

test('omitting acquisition completeness must never imply passed', () => {
  const result = summarizeChecks({ runs: [success()], headSha: head });
  assert.equal(result.status, 'unknown');
  assert.equal(result.complete, false);
  assert.equal(result.truncated, false);
  assert.match(result.collectionReason, /采集.*完整/);
  assert.ok(result.reason.includes(result.collectionReason));
});

for (const [status, run] of [
  ['passed', success()],
  ['failed', success({ conclusion: 'failure' })],
  ['pending', success({ status: 'in_progress', conclusion: null })],
  ['unknown', success({ conclusion: 'neutral' })],
]) {
  test(`${status}: acquisition flags do not depend on execution status`, () => {
    const full = summarizeChecks({ runs: [run], headSha: head, complete: true });
    assert.equal(full.status, status);
    assert.equal(full.complete, true);
    assert.equal(full.truncated, false);
    assert.equal(full.collectionReason, null);

    const partial = summarizeChecks({ runs: [run], headSha: head, complete: true, truncated: true });
    assert.equal(partial.status, status === 'passed' ? 'unknown' : status);
    assert.equal(partial.complete, false);
    assert.equal(partial.truncated, true);
    assert.match(partial.collectionReason, /截断/);
    assert.ok(partial.reason.includes(partial.collectionReason));

    const error = summarizeChecks({
      runs: [run], headSha: head, complete: true, collectionReason: 'CI 第 2 页请求失败',
    });
    assert.equal(error.status, status === 'passed' ? 'unknown' : status);
    assert.equal(error.complete, false);
    assert.equal(error.collectionReason, 'CI 第 2 页请求失败');
    assert.ok(error.reason.includes(error.collectionReason));
  });
}

for (const conclusion of ['pending', 'queued', 'in_progress', 'waiting', 'requested']) {
  test(`explicit unfinished conclusion is pending: ${conclusion}`, () => {
    const result = summarizeChecks({ runs: [success({ conclusion })], headSha: head, complete: true });
    assert.equal(result.status, 'pending');
    assert.equal(result.complete, true);
  });
}

for (const run of [success({ status: null }), success({ status: 'unrecognized', conclusion: null }), success({ conclusion: null })]) {
  test(`missing/unknown execution evidence is not assumed pending: ${JSON.stringify(run)}`, () => {
    const result = summarizeChecks({ runs: [run], headSha: head, complete: true });
    assert.equal(result.status, 'unknown');
  });
}

for (const runs of [null, {}, 'bad JSON', [success(), null], [success(), []], [success(), 42], [success({ conclusion: {} })]]) {
  test(`malformed transport cannot silently drop checks or pass: ${JSON.stringify(runs)}`, () => {
    const result = summarizeChecks({ runs, headSha: head, complete: true });
    assert.equal(result.status, 'unknown');
    assert.equal(result.complete, false);
    assert.equal(result.truncated, false);
    assert.equal(typeof result.collectionReason, 'string');
    assert.ok(result.reason.includes(result.collectionReason));
  });
}

test('empty and unavailable results remain unknown with consistent acquisition flags', () => {
  const empty = summarizeChecks({ runs: [], headSha: head, complete: true });
  assert.equal(empty.status, 'unknown');
  assert.equal(empty.complete, true);
  assert.equal(empty.truncated, false);
  assert.equal(empty.collectionReason, null);
  const truncated = summarizeChecks({ runs: [], headSha: head, complete: true, truncated: true });
  assert.equal(truncated.status, 'unknown');
  assert.equal(truncated.complete, false);
  assert.equal(truncated.truncated, true);
  assert.match(truncated.reason, /截断/);
  assert.equal(mapCheckRun([]), null);
});
