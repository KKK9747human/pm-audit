import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { verifyBundle } from '../src/bundle.mjs';
import { signatureOf } from '../src/watch.mjs';
import { acquireProjectLock, releaseProjectLock, auditGenerationComplete } from '../src/project-lock.mjs';
import { auditConsistency } from '../src/refresh-state.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));

function launch(args, env) {
  const child = spawn(process.execPath, args, { cwd: env.PM_TEST_ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
  const closed = new Promise((resolve) => {
    child.once('error', (err) => { stderr += err.message; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
  return { child, closed };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pm-refresh-process-'));
  const processes = [];
  const events = () => existsSync(join(root, 'events.jsonl'))
    ? readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  t.after(async () => {
    for (const p of processes) if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGKILL');
    await Promise.all(processes.map((p) => p.closed));
    const denied = events().filter((e) => e.type === 'denied');
    rmSync(root, { recursive: true, force: true });
    assert.deepEqual(denied, [], 'external I/O must stay mocked');
  });
  for (const dir of ['src', 'bin']) {
    mkdirSync(join(root, dir));
    for (const name of readdirSync(join(repo, dir))) {
      if (name.endsWith('.mjs')) copyFileSync(join(repo, dir, name), join(root, dir, name));
    }
  }
  copyFileSync(join(repo, 'server.mjs'), join(root, 'server.mjs'));
  copyFileSync(join(repo, 'test', 'lib', 'refresh-process.cjs'), join(root, 'preload.cjs'));
  const projectDir = join(root, 'projects', 'demo');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
    id: 'demo', name: 'Fixture only', repo: 'fixture/never-contact', localRepo: null,
    defaultBranch: 'main', admin: 'fixture-admin', members: {}, staleDays: 5,
    activeWindowDays: 14, commitWindowDays: 30, maxBranchesToScan: 8, plan: 'plan.json',
  }));
  const plan = (title) => writeFileSync(join(projectDir, 'plan.json'), JSON.stringify({
    nodes: [{ id: 'N1', title, owner: 'A', est: 'S', deps: [], files: [], acceptance: 'fixture only' }],
  }));
  plan('Fixture first');
  const control = (value) => writeFileSync(join(root, 'control.json'), JSON.stringify(value));
  control({});
  const env = {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    TEMP: root, TMP: root, PATH: dirname(process.execPath),
    PM_PORT: '0', PM_TEST_ROOT: root,
    NODE_OPTIONS: `--require ${JSON.stringify(join(root, 'preload.cjs'))}`,
  };
  const start = (args, extra = {}) => {
    const p = launch(args, { ...env, ...extra });
    processes.push(p);
    return p;
  };
  const json = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
  const bytes = (file) => existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null;
  return {
    root, plan, control, events, json, bytes, start,
    cli: async (args = [], extra = {}) => {
      const result = await start([join(root, 'bin', 'pmctl.mjs'), 'audit', 'demo', ...args], extra).closed;
      assert.equal(result.timedOut, false, result.stderr);
      return result;
    },
    server: async () => {
      const p = start([join(root, 'server.mjs')]);
      const ready = new Promise((resolve) => p.child.on('message', (message) => {
        if (message.type === 'listening') resolve(message.port);
      }));
      const port = await Promise.race([ready, p.closed.then((result) => { throw new Error(`server exited before listening: ${result.stderr}`); })]);
      return async (query = '') => {
        const response = await fetch(`http://127.0.0.1:${port}/api/projects/demo/refresh${query}`, { method: 'POST', signal: AbortSignal.timeout(10000) });
        return { status: response.status, body: await response.json() };
      };
    },
  };
}

const BUNDLE = 'data/demo/bundle.pm.json';
const SERVER_STATE = 'cache/demo/refresh-state.json';
const CLI_STATE = 'cache/demo/watch-state.json';
const LOCK = 'cache/demo/project.lock';

test('真实服务端→CLI首次和再次审计，父锁保留到close且只推进server检查点', async (t) => {
  const f = fixture(t);
  const refresh = await f.server();
  const first = await refresh();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  const old = f.json(BUNDLE);
  assert.equal(verifyBundle(old).ok, true);
  assert.equal(f.json(SERVER_STATE).auditedHash, old.hashes.facts);
  assert.equal(f.bytes(CLI_STATE), null);
  assert.equal(f.bytes(LOCK), null);
  f.plan('Fixture second');
  const second = await refresh();
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const current = f.json(BUNDLE);
  assert.equal(verifyBundle(current).ok, true);
  assert.notEqual(current.hashes.facts, old.hashes.facts);
  assert.equal(f.json(SERVER_STATE).auditedHash, current.hashes.facts);
  assert.equal(f.bytes(CLI_STATE), null);
  assert.equal(f.bytes(LOCK), null);
  const closes = f.events().filter((e) => e.type === 'audit-close');
  assert.equal(closes.length, 2);
  assert.ok(closes.every((e) => e.lockPresent && e.code === 0));
});

test('外部真实持锁时HTTP返回409、CLI返回70且包和检查点均不变', async (t) => {
  const f = fixture(t);
  assert.equal((await f.cli()).code, 0);
  const before = [BUNDLE, CLI_STATE, SERVER_STATE].map(f.bytes);
  const lock = acquireProjectLock(f.root, 'demo');
  try {
    const refresh = await f.server();
    const result = await refresh();
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'BUSY');
    assert.equal((await f.cli()).code, 70);
    assert.deepEqual([BUNDLE, CLI_STATE, SERVER_STATE].map(f.bytes), before);
    assert.equal(f.events().filter((e) => e.type === 'audit-start').length, 0);
  } finally {
    releaseProjectLock(lock);
  }
});

test('外部真实持锁时 watch --once 跳过项目且不改检查点', async (t) => {
  const f = fixture(t);
  assert.equal((await f.cli()).code, 0);
  const before = f.bytes(CLI_STATE);
  const lock = acquireProjectLock(f.root, 'demo');
  try {
    const result = await f.start([join(f.root, 'bin', 'pmctl.mjs'), 'watch', 'demo', '--once', '--no-interpret'], {}).closed;
    assert.equal(result.timedOut, false);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /另一个进程|BUSY/);
    assert.equal(f.bytes(CLI_STATE), before);
  } finally {
    releaseProjectLock(lock);
  }
});

test('真实子进程写包后崩溃，残锁被安全拒绝且不再推进检查点', async (t) => {
  const f = fixture(t);
  assert.equal((await f.cli()).code, 0);
  const oldHash = f.json(BUNDLE).hashes.facts;
  f.plan('Crash before checkpoint');
  const crashed = await f.start([join(f.root, 'bin', 'pmctl.mjs'), 'audit', 'demo'], { PM_CRASH_AFTER_BUNDLE: '1' }).closed;
  assert.equal(crashed.timedOut, false);
  assert.notEqual(crashed.code, 0, JSON.stringify(crashed));
  assert.notEqual(f.json(BUNDLE).hashes.facts, oldHash);
  assert.equal(f.json(CLI_STATE).auditedHash, oldHash);
  const lockBytes = f.bytes(LOCK);
  assert.ok(lockBytes, '崩溃应留下项目锁');
  const refresh = await f.server();
  const result = await refresh();
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'BUSY');
  assert.equal(f.bytes(LOCK), lockBytes, '残锁不得被移动或删除');
  assert.equal(f.json(CLI_STATE).auditedHash, oldHash);
  assert.equal(f.events().filter((e) => e.type === 'audit-start').length, 0);

  const unlock = await f.start([join(f.root, 'bin', 'pmctl.mjs'), 'unlock', 'demo'], {}).closed;
  assert.equal(unlock.code, 0, unlock.stderr);
  assert.equal(f.bytes(LOCK), null);
  const recovered = await refresh();
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  const final = f.json(BUNDLE);
  assert.equal(verifyBundle(final).ok, true);
  assert.equal(f.json(SERVER_STATE).auditedHash, final.hashes.facts);
  assert.equal(f.bytes(LOCK), null);
});

test('自动轮次：一致时跳过，包与检查点不一致时重算并修复', async (t) => {
  const f = fixture(t);
  f.control({ mode: 'probe-unchanged' });
  assert.equal((await f.cli()).code, 0);
  const bundle = f.json(BUNDLE);
  const probe = {
    pushedAt: '2026-11-20T10:00:00Z', defaultBranch: 'main', repositoryDefaultBranch: 'main',
    headSha: 'a'.repeat(40), branches: [{ name: 'main', sha: 'a'.repeat(40) }],
    openPrs: [], openIssues: [], snapshotComplete: true, recentCommits: [], commitsComplete: false,
    compareBase: null, compareHead: 'a'.repeat(40), budgetExhausted: false, timeoutStage: null,
  };
  const seed = {
    auditedHash: bundle.hashes.facts, auditedSignature: signatureOf(probe), auditedProbe: probe, tickCount: 1,
  };
  writeFileSync(join(f.root, SERVER_STATE), `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

  const refresh = await f.server();
  const same = await refresh('?auto=1');
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.skipped, true);

  const tampered = { ...seed, auditedHash: 'sha256:' + '0'.repeat(64) };
  writeFileSync(join(f.root, SERVER_STATE), `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
  const repaired = await refresh('?auto=1');
  assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
  assert.notEqual(repaired.body.skipped, true);
  assert.equal(f.json(SERVER_STATE).auditedHash, f.json(BUNDLE).hashes.facts);

  writeFileSync(join(f.root, BUNDLE), '{broken', 'utf8');
  const corrupt = await refresh('?auto=1');
  assert.equal(corrupt.status, 200, JSON.stringify(corrupt.body));
  assert.equal(verifyBundle(f.json(BUNDLE)).ok, true);
  assert.equal(f.json(SERVER_STATE).auditedHash, f.json(BUNDLE).hashes.facts);
});

test('CLI watch：一致时跳过，包与检查点不一致时重算并修复', async (t) => {
  const f = fixture(t);
  f.control({ mode: 'probe-unchanged' });
  assert.equal((await f.cli()).code, 0);
  const bundle = f.json(BUNDLE);
  const probe = {
    pushedAt: '2026-11-20T10:00:00Z', defaultBranch: 'main', repositoryDefaultBranch: 'main',
    headSha: 'a'.repeat(40), branches: [{ name: 'main', sha: 'a'.repeat(40) }],
    openPrs: [], openIssues: [], snapshotComplete: true, recentCommits: [], commitsComplete: false,
    compareBase: null, compareHead: 'a'.repeat(40), budgetExhausted: false, timeoutStage: null,
  };
  const seed = {
    auditedHash: bundle.hashes.facts, auditedSignature: signatureOf(probe), auditedProbe: probe, tickCount: 1,
  };
  writeFileSync(join(f.root, CLI_STATE), `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  const run = () => f.start([join(f.root, 'bin', 'pmctl.mjs'), 'watch', 'demo', '--once', '--no-interpret'], {}).closed;

  const same = await run();
  assert.equal(same.code, 0, same.stderr);
  assert.equal(f.json(CLI_STATE).lastAuditedAt, undefined, '一致时不得重算');

  const tampered = { ...seed, auditedHash: 'sha256:' + '0'.repeat(64), lastAuditedAt: undefined };
  writeFileSync(join(f.root, CLI_STATE), `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
  const repaired = await run();
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.equal(f.json(CLI_STATE).auditedHash, f.json(BUNDLE).hashes.facts);
  assert.ok(f.json(CLI_STATE).lastAuditedAt, '不一致时必须重算');
});

test('alerts 命令落盘两个文件并正常退出', async (t) => {
  const f = fixture(t);
  assert.equal((await f.cli()).code, 0);
  const result = await f.start([join(f.root, 'bin', 'pmctl.mjs'), 'alerts', 'demo'], {}).closed;
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.json('data/demo/alerts.json').hash, f.json(BUNDLE).hashes.facts);
  assert.ok(f.bytes('data/demo/alerts.md').length > 0);
});

test('alerts 重写派生报告后审计代次仍完整，不触发下轮强制重算', async (t) => {
  const f = fixture(t);
  assert.equal((await f.cli()).code, 0);
  const state = f.json(CLI_STATE);
  assert.equal(state.auditedHash, f.json(BUNDLE).hashes.facts);
  const result = await f.start([join(f.root, 'bin', 'pmctl.mjs'), 'alerts', 'demo'], {}).closed;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(auditGenerationComplete(f.root, 'demo', f.json(BUNDLE).hashes.facts), true);
  const consistency = auditConsistency(f.root, 'demo', f.json(CLI_STATE));
  assert.equal(consistency.mismatch, false, consistency.reason);
  assert.deepEqual(readdirSync(join(f.root, 'data', 'demo')).filter((name) => name.endsWith('.tmp')), []);
});

test('trail 重写派生报告后审计代次仍完整', async (t) => {
  const f = fixture(t);
  assert.equal((await f.cli()).code, 0);
  const result = await f.start([join(f.root, 'bin', 'pmctl.mjs'), 'trail', 'demo'], {}).closed;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(auditGenerationComplete(f.root, 'demo', f.json(BUNDLE).hashes.facts), true);
  assert.deepEqual(readdirSync(join(f.root, 'data', 'demo')).filter((name) => name.endsWith('.tmp')), []);
});

test('普通独立CLI首次和再次审计仍可验证并维护自己的检查点', async (t) => {
  const f = fixture(t);
  assert.equal((await f.cli()).code, 0);
  const first = f.json(BUNDLE);
  assert.equal(verifyBundle(first).ok, true);
  f.plan('Standalone second');
  assert.equal((await f.cli(['--fresh'])).code, 0);
  const second = f.json(BUNDLE);
  assert.equal(verifyBundle(second).ok, true);
  assert.notEqual(first.hashes.facts, second.hashes.facts);
  assert.equal(f.json(CLI_STATE).auditedHash, second.hashes.facts);
  assert.equal(f.bytes(SERVER_STATE), null);
  assert.equal(f.bytes(LOCK), null);
});

test('真实CLI使用有效父进程委托，不释放父锁也不修改CLI检查点', async (t) => {
  const f = fixture(t);
  assert.equal((await f.cli()).code, 0);
  const before = f.bytes(CLI_STATE);
  f.plan('Delegated second');
  const lock = acquireProjectLock(f.root, 'demo');
  const lockBefore = f.bytes(LOCK);
  try {
    const result = await f.cli(['--fresh', '--parent-lock'], {
      PM_AUDIT_LOCK: JSON.stringify({ root: f.root, id: 'demo', token: lock.token, pid: process.pid }),
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(verifyBundle(f.json(BUNDLE)).ok, true);
    assert.equal(f.bytes(CLI_STATE), before);
    assert.equal(f.bytes(LOCK), lockBefore);
  } finally {
    releaseProjectLock(lock);
  }
});

for (const invalid of ['missing', 'malformed', 'token', 'root', 'project', 'pid']) {
  test(`无效父进程委托(${invalid})在外部I/O和共享写入前拒绝`, async (t) => {
    const f = fixture(t);
    const lock = acquireProjectLock(f.root, 'demo');
    const before = f.bytes(LOCK);
    const delegation = { root: f.root, id: 'demo', token: lock.token, pid: process.pid };
    if (invalid === 'token') delegation.token = 'wrong-token';
    if (invalid === 'root') delegation.root = join(f.root, 'other-root');
    if (invalid === 'project') delegation.id = 'other-project';
    if (invalid === 'pid') delegation.pid = 0;
    try {
      const env = invalid === 'missing' ? {} : { PM_AUDIT_LOCK: invalid === 'malformed' ? '{' : JSON.stringify(delegation) };
      const result = await f.cli(['--fresh', '--parent-lock'], env);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /委托|父进程/);
      assert.equal(f.bytes(LOCK), before);
      assert.equal(f.bytes(BUNDLE), null);
      assert.equal(f.bytes(CLI_STATE), null);
      assert.equal(f.bytes(SERVER_STATE), null);
      assert.equal(f.bytes('cache/demo/raw.json'), null);
      assert.deepEqual(f.events(), []);
    } finally {
      releaseProjectLock(lock);
    }
  });
}

test('即使令牌和锁记录匹配，也拒绝实际持锁者不是直接父进程的委托', async (t) => {
  const f = fixture(t);
  const holder = f.start(['--input-type=module', '-e', `
    import { acquireProjectLock, releaseProjectLock } from './src/project-lock.mjs';
    const lock = acquireProjectLock(process.env.PM_TEST_ROOT, 'demo');
    process.send({ type: 'held', root: lock.root, id: lock.id, token: lock.token, pid: process.pid });
    process.on('message', () => { releaseProjectLock(lock); process.disconnect(); });
  `]);
  const ready = new Promise((resolve) => holder.child.on('message', (message) => {
    if (message.type === 'held') resolve(message);
  }));
  const delegation = await Promise.race([ready, holder.closed.then((result) => { throw new Error(result.stderr || 'holder exited'); })]);
  const before = f.bytes(LOCK);
  try {
    const result = await f.cli(['--parent-lock'], { PM_AUDIT_LOCK: JSON.stringify(delegation) });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /父进程/);
    assert.equal(f.bytes(LOCK), before);
    assert.equal(f.bytes(BUNDLE), null);
    assert.equal(f.bytes(CLI_STATE), null);
    assert.deepEqual(f.events(), []);
  } finally {
    if (holder.child.connected) holder.child.send('release');
    assert.equal((await holder.closed).code, 0);
  }
});

test('旧no-lock布尔开关不能绕过锁或变成普通审计', async (t) => {
  const f = fixture(t);
  const result = await f.cli(['--no-lock']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no-lock/);
  assert.equal(f.bytes(BUNDLE), null);
  assert.equal(f.bytes(CLI_STATE), null);
  assert.deepEqual(f.events(), []);
});

for (const mode of ['revoke-ingest', 'revoke-identity']) {
  test(`委托在${mode}外部调用期间失效后不得继续覆盖共享数据`, async (t) => {
    const f = fixture(t);
    assert.equal((await f.cli()).code, 0);
    const files = [BUNDLE, CLI_STATE, 'data/demo/agent/index.json', 'data/demo/brief-history.json'];
    if (mode === 'revoke-ingest') files.push('cache/demo/raw.json');
    const before = files.map(f.bytes);
    f.plan('Revoked audit must not save');
    f.control({ mode });
    const lock = acquireProjectLock(f.root, 'demo');
    const result = await f.cli(['--fresh', '--parent-lock'], {
      PM_AUDIT_LOCK: JSON.stringify({ root: f.root, id: 'demo', token: lock.token, pid: process.pid }),
    });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /项目锁|委托/);
    assert.deepEqual(files.map(f.bytes), before);
    assert.equal(f.json(LOCK).token, 'fixture-successor');
  });
}

for (const mode of ['error', 'timeout', 'abort']) {
  test(`真实审计子进程${mode}后等close释放父锁，下一次刷新可恢复`, async (t) => {
    const f = fixture(t);
    assert.equal((await f.cli()).code, 0);
    const before = f.bytes(BUNDLE);
    const cliBefore = f.bytes(CLI_STATE);
    f.control({ mode, timeout: 1500 });
    const refresh = await f.server();
    const failed = await refresh();
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.equal(f.bytes(BUNDLE), before);
    assert.equal(f.bytes(CLI_STATE), cliBefore);
    assert.equal(f.json(SERVER_STATE).auditedHash, undefined);
    assert.equal(f.bytes(LOCK), null);
    const close = f.events().find((e) => e.type === 'audit-close');
    assert.ok(close?.lockPresent, 'parent lock must still exist at child close');
    if (mode === 'abort') {
      const events = f.events();
      const boundary = events.findIndex((e) => e.type === 'audit-error-boundary');
      assert.ok(boundary >= 0 && boundary < events.findIndex((e) => e.type === 'audit-close'));
      assert.equal(events[boundary].busy, true, 'error callback must not release the lock before close');
    }
    assert.throws(() => process.kill(close.child, 0), { code: 'ESRCH' });
    f.control({});
    const recovered = await refresh();
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(verifyBundle(f.json(BUNDLE)).ok, true);
    assert.equal(f.json(SERVER_STATE).auditedHash, f.json(BUNDLE).hashes.facts);
    assert.equal(f.bytes(CLI_STATE), cliBefore);
  });
}
