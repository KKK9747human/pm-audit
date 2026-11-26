import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  readState,
  writeState,
  recordPending,
  recordPublishResult,
  pendingDecision,
  pendingNeedsAudit,
  recordObservation,
  recordAudit,
  recordAuditBundle,
  publishPending,
  reconcilePending,
  knownOwnCommits,
  auditConsistency,
  applyAuditConsistency,
} from '../src/refresh-state.mjs';
import { writeBundle, writeAuditGeneration } from '../src/project-lock.mjs';
import { buildBundle } from '../src/bundle.mjs';
import { buildFacts } from '../src/facts.mjs';
import { samplePlan, sampleProject, sampleRaw } from './lib/fixture.mjs';

function fixture() {
  return mkdtempSync(join(tmpdir(), 'pm-refresh-state-'));
}

test('待发布状态可持久化并在重启后读取', () => {
  const root = fixture();
  try {
    writeState(root, 'demo', 'server', { signature: 's1', tickCount: 2 });
    recordPending(root, 'demo', 'server', { hash: 'sha256:a', signature: 's1' });
    const state = readState(root, 'demo', 'server');
    assert.equal(state.pendingPublish.hash, 'sha256:a');
    assert.equal(state.signature, 's1');
    assert.equal(state.tickCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('失败发布即使远端无变化也要生成待发布任务', () => {
  const root = fixture();
  try {
    recordPending(root, 'demo', 'server', { hash: 'sha256:a', signature: 'same', error: '网络失败' });
    const state = readState(root, 'demo', 'server');
    const decision = pendingDecision({ state, hash: 'sha256:a', allowPublish: true });
    assert.equal(decision.publish, true);
    assert.equal(decision.audit, false);
    assert.equal(pendingNeedsAudit(state, 'sha256:a'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('发布成功或 same 清除待发布；失败保留并累计次数', () => {
  const root = fixture();
  try {
    let state = recordPending(root, 'demo', 'server', { hash: 'sha256:a' });
    recordPublishResult(root, 'demo', 'server', {
      hash: 'sha256:a', result: 'error', error: '失败', attemptId: state.pendingPublish.attemptId,
    });
    state = readState(root, 'demo', 'server');
    assert.equal(state.pendingPublish.attempts, 1);
    assert.equal(state.pendingPublish.lastError, '失败');
    assert.equal(state.publishedHash, undefined);

    state = recordPending(root, 'demo', 'server', { hash: 'sha256:a' });
    assert.equal(state.pendingPublish.attempts, 2);
    recordPublishResult(root, 'demo', 'server', {
      hash: 'sha256:a', confirmedHash: 'sha256:a', result: 'published', attemptId: state.pendingPublish.attemptId,
    });
    state = readState(root, 'demo', 'server');
    assert.equal(state.pendingPublish, undefined);
    assert.equal(state.publishedHash, 'sha256:a');

    state = recordPending(root, 'demo', 'server', { hash: 'sha256:b' });
    assert.equal(state.pendingPublish.attempts, 1);
    recordPublishResult(root, 'demo', 'server', {
      hash: 'sha256:b', confirmedHash: 'sha256:b', result: 'same', attemptId: state.pendingPublish.attemptId,
    });
    assert.equal(readState(root, 'demo', 'server').pendingPublish, undefined);
    assert.equal(readState(root, 'demo', 'server').publishedHash, 'sha256:b');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('新审计包需要重新审计后再发布，不把旧包成功记到新包', () => {
  const root = fixture();
  try {
    recordPending(root, 'demo', 'server', { hash: 'sha256:a' });
    const state = readState(root, 'demo', 'server');
    const decision = pendingDecision({ state, hash: 'sha256:b', allowPublish: true });
    assert.equal(decision.publish, true);
    assert.equal(decision.audit, true);
    assert.equal(pendingNeedsAudit(state, 'sha256:b'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('不允许发布的入口不触发写回', () => {
  const root = fixture();
  try {
    recordPending(root, 'demo', 'server', { hash: 'sha256:a' });
    const state = readState(root, 'demo', 'server');
    const decision = pendingDecision({ state, hash: 'sha256:a', allowPublish: false });
    assert.equal(decision.publish, false);
    assert.equal(decision.audit, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('服务器与 CLI 状态文件互相隔离', () => {
  const root = fixture();
  try {
    recordPending(root, 'demo', 'server', { hash: 'sha256:a' });
    assert.ok(readState(root, 'demo', 'server').pendingPublish);
    assert.equal(readState(root, 'demo', 'cli'), null);
    assert.equal(readState(root, 'other', 'server'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const result of ['published', 'same', 'error']) {
  test(`旧任务 ${result} 不能清除或覆盖新待发布任务`, (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const old = recordPending(root, 'demo', 'server', { hash: 'sha256:a', signature: 's1' });
    const newer = recordPending(root, 'demo', 'server', { hash: 'sha256:b', signature: 's2' });
    recordPublishResult(root, 'demo', 'server', {
      hash: 'sha256:a', confirmedHash: 'sha256:a', result,
      attemptId: old.pendingPublish.attemptId,
    });
    assert.deepEqual(readState(root, 'demo', 'server'), newer);
  });
}

test('same 返回其他包的指纹不能清除待发布', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = recordPending(root, 'demo', 'cli', { hash: 'sha256:a' });
  recordPublishResult(root, 'demo', 'cli', {
    hash: 'sha256:a', confirmedHash: 'sha256:b', result: 'same',
    attemptId: state.pendingPublish.attemptId,
  });
  assert.equal(readState(root, 'demo', 'cli').pendingPublish.hash, 'sha256:a');
  assert.equal(readState(root, 'demo', 'cli').publishedHash, undefined);
});

test('损坏的状态文件不能被当作没有待发布任务', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeState(root, 'demo', 'server', {});
  writeFileSync(join(root, 'cache', 'demo', 'refresh-state.json'), '{"pendingPublish":');
  assert.throws(() => readState(root, 'demo', 'server'), SyntaxError);
});

test('同一指纹的旧尝试不能确认新的尝试', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = recordPending(root, 'demo', 'server', { hash: 'sha256:a' });
  const newer = recordPending(root, 'demo', 'server', { hash: 'sha256:a' });
  assert.notEqual(old.pendingPublish.attemptId, newer.pendingPublish.attemptId);
  recordPublishResult(root, 'demo', 'server', {
    hash: 'sha256:a', confirmedHash: 'sha256:a', result: 'same', attemptId: old.pendingPublish.attemptId,
  });
  assert.deepEqual(readState(root, 'demo', 'server'), newer);
});

test('观察、审计、发布检查点相互独立，审计与待发布目标一起落盘', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  recordObservation(root, 'demo', 'server', { signature: 's1', probe: { headSha: 'a' } });
  const audited = recordAudit(root, 'demo', 'server', { hash: 'sha256:a', signature: 's1', publish: true });
  assert.equal(audited.auditedHash, 'sha256:a');
  assert.equal(audited.pendingPublish.hash, 'sha256:a');
  assert.equal(audited.pendingPublish.attempts, 0);
  recordObservation(root, 'demo', 'server', { signature: 's2', probe: { headSha: 'b' } });
  await publishPending(root, { id: 'demo' }, { hashes: { facts: 'sha256:a' } }, {
    kind: 'server', signature: 's1',
    publish: async () => ({ status: 'published', hash: 'sha256:a', commit: 'a'.repeat(40) }),
  });
  const state = readState(root, 'demo', 'server');
  assert.equal(state.observedSignature, 's2');
  assert.equal(state.auditedSignature, 's1');
  assert.equal(state.publishedSignature, 's1');
  assert.equal(state.publishedHash, 'sha256:a');
});

test('远端成功但响应丢失，下一次相同包得到 same 后才清待发布', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = { id: 'demo' };
  const bundle = { hashes: { facts: 'sha256:a' } };
  let remoteHash = null;
  const failed = await publishPending(root, project, bundle, {
    kind: 'cli', signature: 's1', publish: async (target) => {
      assert.equal(readState(root, 'demo', 'cli').pendingPublish.hash, target.hashes.facts);
      remoteHash = target.hashes.facts;
      throw new Error('response lost');
    },
  });
  assert.equal(failed.status, 'error');
  assert.equal(readState(root, 'demo', 'cli').pendingPublish.hash, remoteHash);
  const retry = await publishPending(root, project, bundle, {
    kind: 'cli', signature: 's1', publish: async (target) => {
      assert.equal(readState(root, 'demo', 'cli').pendingPublish.attempts, 2);
      assert.equal(target.hashes.facts, remoteHash);
      return { status: 'same', hash: remoteHash };
    },
  });
  assert.equal(retry.status, 'same');
  assert.equal(readState(root, 'demo', 'cli').pendingPublish, undefined);
});

for (const status of ['same', 'published']) {
  test(`${status} 缺少实际包指纹时返回失败而不冒充确认`, async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const result = await publishPending(root, { id: 'demo' }, { hashes: { facts: 'sha256:a' } }, {
      kind: 'server', publish: async () => ({ status }),
    });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'PUBLISH_IDENTITY_MISMATCH');
    assert.equal(readState(root, 'demo', 'server').pendingPublish.hash, 'sha256:a');
  });
}

test('审计后进程重启仍保留尚未开始网络调用的发布任务', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = { id: 'demo' };
  const bundle = { hashes: { facts: 'sha256:a' } };
  recordAudit(root, project.id, 'server', { hash: bundle.hashes.facts, signature: 's1', publish: true });
  const moduleUrl = new URL('../src/refresh-state.mjs', import.meta.url).href;
  const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { readState } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(readState(process.argv[1], 'demo', 'server')));`, root,
  ], { encoding: 'utf8' }));
  const decision = pendingDecision({ state: restored, hash: bundle.hashes.facts, allowPublish: true });
  assert.equal(decision.publish, true);
  assert.equal(decision.audit, false);
  assert.equal(restored.pendingPublish.attemptId, null);
  await publishPending(root, project, bundle, {
    kind: 'server', signature: restored.pendingPublish.signature,
    publish: async () => {
      assert.equal(readState(root, project.id, 'server').pendingPublish.attempts, 1);
      return { status: 'same', hash: bundle.hashes.facts };
    },
  });
  assert.equal(readState(root, project.id, 'server').pendingPublish, undefined);
});

test('状态替换失败保留原文件，且清理本次临时文件', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = recordPending(root, 'demo', 'server', { hash: 'sha256:a' });
  const circular = {};
  circular.self = circular;
  assert.throws(() => writeState(root, 'demo', 'server', circular), TypeError);
  assert.deepEqual(readState(root, 'demo', 'server'), old);
  assert.deepEqual(readdirSync(join(root, 'cache', 'demo')), ['refresh-state.json']);
});

for (const kind of ['server', 'cli']) {
  test(`${kind}: read-only reconciliation records the exact pending identity and manifest commit`, async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const project = { id: 'demo' };
    const hash = `sha256:${'a'.repeat(64)}`;
    const state = recordPending(root, project.id, kind, { hash, signature: 'baseline' });
    const commit = 'c'.repeat(40);
    const parent = 'b'.repeat(40);
    const result = await reconcilePending(root, project, {
      kind, ...state.pendingPublish,
      confirm: async (actualProject, requestedHash) => {
        assert.equal(actualProject, project);
        assert.equal(requestedHash, hash);
        assert.deepEqual(readState(root, project.id, kind), state);
        return { status: 'confirmed', hash, commit, parent };
      },
    });
    assert.equal(result.status, 'confirmed');
    const after = readState(root, project.id, kind);
    assert.equal(after.pendingPublish, undefined);
    assert.equal(after.publishedHash, hash);
    assert.equal(after.publishedSignature, 'baseline');
    assert.equal(after.publishedCommit, commit);
    assert.equal(after.publishedParent, parent);
    assert.deepEqual([...knownOwnCommits(after)], [commit]);
  });
}

for (const status of ['absent', 'not-match']) {
  test(`reconcile ${status} leaves pending identity, counters and watermarks intact`, async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const state = recordPending(root, 'demo', 'cli', { hash: 'sha256:a', signature: 'baseline' });
    const result = await reconcilePending(root, { id: 'demo' }, {
      kind: 'cli', ...state.pendingPublish,
      confirm: async () => ({ status, hash: 'sha256:b' }),
    });
    assert.equal(result.status, status);
    assert.deepEqual(readState(root, 'demo', 'cli'), state);
  });
}

for (const patch of [
  { hash: 'sha256:b' }, { commit: null }, { commit: 'short' }, { parent: null },
  { parent: 'short' }, { parent: 'c'.repeat(40) }, { status: 'invalid' }, { status: 'untrusted' },
]) {
  test(`reconcile rejects incomplete confirmation: ${JSON.stringify(patch)}`, async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const state = recordPending(root, 'demo', 'server', { hash: 'sha256:a' });
    await assert.rejects(reconcilePending(root, { id: 'demo' }, {
      kind: 'server', ...state.pendingPublish,
      confirm: async () => ({ status: 'confirmed', hash: 'sha256:a', commit: 'c'.repeat(40), parent: 'b'.repeat(40), ...patch }),
    }), { code: 'PUBLISH_IDENTITY_MISMATCH' });
    const after = readState(root, 'demo', 'server');
    assert.equal(after.publishedHash, undefined);
    for (const key of ['hash', 'attemptId', 'attempts', 'signature']) {
      assert.equal(after.pendingPublish[key], state.pendingPublish[key]);
    }
    assert.ok(after.pendingPublish.lastError);
  });
}

for (const hash of ['sha256:a', 'sha256:b']) {
  for (const fail of [false, true]) {
    test(`reconcile cannot consume a newer pending ${hash} when confirmation ${fail ? 'fails' : 'succeeds'}`, async (t) => {
      const root = fixture();
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const old = recordPending(root, 'demo', 'cli', { hash: 'sha256:a' });
      let newer;
      const error = new Error('fixture lost confirmation');
      const run = reconcilePending(root, { id: 'demo' }, {
        kind: 'cli', ...old.pendingPublish,
        confirm: async () => {
          newer = recordPending(root, 'demo', 'cli', { hash });
          if (fail) throw error;
          return { status: 'confirmed', hash: 'sha256:a', commit: 'c'.repeat(40), parent: 'b'.repeat(40) };
        },
      });
      if (fail) await assert.rejects(run, (err) => err === error);
      else assert.equal((await run).status, 'skipped');
      assert.deepEqual(readState(root, 'demo', 'cli'), newer);
    });
  }
}

for (const patch of [{ hash: 'sha256:b' }, { attemptId: 'stale' }, { attemptId: null }]) {
  test(`reconcile stale or unstarted request is a no-op: ${JSON.stringify(patch)}`, async (t) => {
    const root = fixture();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const state = recordPending(root, 'demo', 'server', { hash: 'sha256:a' });
    const result = await reconcilePending(root, { id: 'demo' }, {
      kind: 'server', ...state.pendingPublish, ...patch,
      confirm: () => assert.fail('stale request must not contact remote'),
    });
    assert.equal(result.status, 'skipped');
    assert.deepEqual(readState(root, 'demo', 'server'), state);
  });
}

test('auditConsistency：包指纹与检查点不一致时报告 mismatch', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeBundle(root, { project: { id: 'demo' }, version: 2, hashes: { facts: 'sha256:new' } });
  const result = auditConsistency(root, 'demo', { auditedHash: 'sha256:old' });
  assert.equal(result.mismatch, true);
  assert.equal(result.hash, 'sha256:new');
  assert.equal(result.checkpoint, 'sha256:old');
  assert.match(result.reason, /不一致/);
});

test('auditConsistency：指纹一致时不报告 mismatch', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const raw = sampleRaw();
  const project = sampleProject();
  const bundle = buildBundle(project, raw, buildFacts(samplePlan(), raw, project, raw.fetchedAt));
  writeBundle(root, bundle);
  writeAuditGeneration(root, 'demo', bundle.hashes.facts, ['bundle.pm.json']);
  const result = auditConsistency(root, 'demo', { auditedHash: bundle.hashes.facts });
  assert.equal(result.mismatch, false);
  assert.equal(result.bundle?.hashes?.facts, bundle.hashes.facts);
});

test('auditConsistency：指纹一致但内容被改仍报告 mismatch', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const raw = sampleRaw();
  const project = sampleProject();
  const bundle = buildBundle(project, raw, buildFacts(samplePlan(), raw, project, raw.fetchedAt));
  bundle.facts = { ...bundle.facts, stats: { ...bundle.facts.stats, done: 99 } };
  writeBundle(root, bundle);
  writeAuditGeneration(root, 'demo', bundle.hashes.facts, ['bundle.pm.json']);
  const result = auditConsistency(root, 'demo', { auditedHash: bundle.hashes.facts });
  assert.equal(result.mismatch, true);
  assert.match(result.reason, /不自洽/);
});

test('auditConsistency：同指纹但派生文件被改报告 mismatch', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const raw = sampleRaw();
  const project = sampleProject();
  const bundle = buildBundle(project, raw, buildFacts(samplePlan(), raw, project, raw.fetchedAt));
  recordAuditBundle(root, 'demo', 'cli', bundle, { 'audit.md': '# ok' });
  writeFileSync(join(root, 'data', 'demo', 'audit.md'), '# truncated', 'utf8');
  const result = auditConsistency(root, 'demo', { auditedHash: bundle.hashes.facts });
  assert.equal(result.mismatch, true);
  assert.match(result.reason, /代次/);
});

test('auditConsistency：包损坏即 mismatch 且不抛错', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data', 'demo'), { recursive: true });
  writeFileSync(join(root, 'data', 'demo', 'bundle.pm.json'), '{broken', 'utf8');
  const result = auditConsistency(root, 'demo', { auditedHash: 'sha256:old' });
  assert.equal(result.mismatch, true);
  assert.equal(result.bundle, null);
  assert.ok(result.loadError);
  assert.match(result.reason, /无法读取/);
});

test('auditConsistency：包缺失但检查点存在即 mismatch', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = auditConsistency(root, 'demo', { auditedHash: 'sha256:old' });
  assert.equal(result.mismatch, true);
  assert.match(result.reason, /缺失/);
});

test('auditConsistency：pending 与当前包一致时不报告 mismatch', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeBundle(root, { project: { id: 'demo' }, version: 2, hashes: { facts: 'sha256:new' } });
  const result = auditConsistency(root, 'demo', {
    auditedHash: 'sha256:old', pendingPublish: { hash: 'sha256:new' },
  });
  assert.equal(result.mismatch, false);
});

test('auditConsistency：无检查点时不因缺包误报', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(auditConsistency(root, 'demo', null).mismatch, false);
});

test('applyAuditConsistency：不一致时强制重算但保留真实发布授权', (t) => {
  const decision = { refresh: false, real: true, reason: '远端有变化' };
  const result = applyAuditConsistency(decision, { mismatch: true, reason: '包与检查点不一致' });
  assert.equal(result.refresh, true);
  assert.equal(result.real, true);
  assert.equal(result.reason, '包与检查点不一致');
});

test('applyAuditConsistency：一致时不改决策', (t) => {
  const decision = { refresh: false, real: false, reason: '无变化' };
  assert.deepEqual(applyAuditConsistency(decision, { mismatch: false }), decision);
});
