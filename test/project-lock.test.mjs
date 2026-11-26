import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync,
  openSync, closeSync, renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import * as nodePath from 'node:path';
import * as nodeCrypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContext, Script } from 'node:vm';
import {
  acquireProjectLock, releaseProjectLock, writeBundle, writeDerivedFile, writeBundleFiles,
  writeAtomicFile,
  projectLockPath, readLockOwner, clearStaleProjectLock,
  writeAuditGeneration, auditGenerationComplete, GENERATION_FILE,
} from '../src/project-lock.mjs';
import { recordAuditBundle } from '../src/refresh-state.mjs';

const modulePath = fileURLToPath(new URL('../src/project-lock.mjs', import.meta.url));
const repo = fileURLToPath(new URL('../', import.meta.url));
const fixture = () => mkdtempSync(join(tmpdir(), 'pm-project-lock-'));
const lockPath = (root, id) => join(root, 'cache', id, 'project.lock');

function waitForExit(child, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('child watchdog expired'));
    }, ms);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function runChild(source, args = [], ms = 8000) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, '--', ...args], { encoding: 'utf8' });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return waitForExit(child, ms).then((exit) => ({ ...exit, stdout, stderr }));
}

const lockChild = (imports, body) => `import { ${imports} } from ${JSON.stringify(pathToFileURL(modulePath).href)};\n${body}`;

test('持锁时返回 BUSY，释放后令牌更换且不会误删他人锁', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = acquireProjectLock(root, 'demo');
  assert.equal(first.acquired, true);
  const second = acquireProjectLock(root, 'demo');
  assert.equal(second.acquired, false);
  assert.equal(second.code, 'BUSY');
  assert.equal(second.error.code, 'BUSY');
  assert.deepEqual(JSON.parse(readFileSync(lockPath(root, 'demo'), 'utf8')), {
    pid: process.pid, token: first.token, acquiredAt: first.acquiredAt,
  });
  assert.equal(releaseProjectLock(first), true);
  assert.equal(existsSync(lockPath(root, 'demo')), false);
  const third = acquireProjectLock(root, 'demo');
  assert.equal(third.acquired, true);
  assert.notEqual(third.token, first.token);
  releaseProjectLock(third);
});

test('活进程的锁即使记录时间很旧也不能被抢走', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const holder = acquireProjectLock(root, 'demo');
  const record = JSON.parse(readFileSync(lockPath(root, 'demo'), 'utf8'));
  writeFileSync(lockPath(root, 'demo'), `${JSON.stringify({ ...record, acquiredAt: 0 })}\n`);
  const contender = acquireProjectLock(root, 'demo');
  assert.equal(contender.code, 'BUSY');
  assert.equal(contender.stale, undefined);
  assert.equal(readFileSync(lockPath(root, 'demo'), 'utf8').includes(holder.token), true);
  releaseProjectLock(holder);
});

test('不同项目的锁互不阻塞', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = acquireProjectLock(root, 'alpha');
  assert.equal(first.acquired, true);
  const second = acquireProjectLock(root, 'beta');
  assert.equal(second.acquired, true);
  assert.notEqual(first.path, second.path);
  releaseProjectLock(first);
  releaseProjectLock(second);
});

test('损坏或半写的锁按 BUSY 处理，不覆盖、不删除', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'cache', 'demo'), { recursive: true });
  writeFileSync(lockPath(root, 'demo'), '{"pid":1,"token"', 'utf8');
  const result = acquireProjectLock(root, 'demo');
  assert.equal(result.code, 'BUSY');
  assert.equal(readFileSync(lockPath(root, 'demo'), 'utf8'), '{"pid":1,"token"');
});

test('确认死亡的进程锁保持 BUSY，不被移动或删除', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = lockPath(root, 'demo');
  mkdirSync(dirname(path), { recursive: true });

  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireProjectLock } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const lock = acquireProjectLock(process.argv[1], 'demo');
    process.stdout.write(lock.token);
    setInterval(() => {}, 1000);
  `, root], { stdio: ['ignore', 'pipe', 'ignore'] });
  let staleToken = '';
  await new Promise((resolve, reject) => holder.stdout.on('data', (chunk) => { staleToken += chunk; resolve(); }).on('error', reject));
  holder.kill('SIGKILL');
  await waitForExit(holder);
  assert.throws(() => process.kill(holder.pid, 0), { code: 'ESRCH' });

  const staleRecord = `${JSON.stringify({ pid: holder.pid, token: staleToken, acquiredAt: Date.now() })}\n`;
  writeFileSync(path, staleRecord, 'utf8');
  const result = acquireProjectLock(root, 'demo');
  assert.equal(result.acquired, false);
  assert.equal(result.code, 'BUSY');
  assert.equal(result.stale, true);
  assert.equal(result.owner.token, staleToken);
  assert.equal(readFileSync(path, 'utf8'), staleRecord, '残锁必须原样保留');
});

test('基于过期快照的抢占者不得移动或删除现役锁', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = lockPath(root, 'demo');
  mkdirSync(dirname(path), { recursive: true });
  const liveToken = 'fixture-live-token';
  const liveRecord = `${JSON.stringify({ pid: process.pid, token: liveToken, acquiredAt: Date.now() })}\n`;
  writeFileSync(path, liveRecord, 'utf8');

  const source = readFileSync(modulePath, 'utf8');
  const expanded = source
    .replace(/\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g, (_, bindings, spec) => `const ${bindings.trim()} = __imports[${JSON.stringify(spec)}];`)
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/g, '');
  const realFs = await import('node:fs');
  let reads = 0;
  const renames = [];
  const proxy = new Proxy({}, {
    get(_, name) {
      if (name === 'readFileSync') {
        return (file, ...args) => {
          if (file === path) {
            reads += 1;
            if (reads === 1) return JSON.stringify({ pid: 999999, token: 'fixture-dead-token', acquiredAt: 0 });
          }
          return realFs.readFileSync(file, ...args);
        };
      }
      if (name === 'renameSync') {
        return (from, to) => {
          renames.push([String(from), String(to)]);
          return realFs.renameSync(from, to);
        };
      }
      return realFs[name];
    },
  });
  const context = createContext({
    __imports: { 'node:fs': proxy, 'node:path': nodePath, 'node:crypto': nodeCrypto },
    process: { pid: process.pid, ppid: process.ppid, kill: (pid, signal) => process.kill(pid, signal) },
    Atomics, SharedArrayBuffer, Date,
  });
  const api = new Script(`${expanded}\n;({ acquireProjectLock });`).runInContext(context);
  const result = api.acquireProjectLock(root, 'demo', { timeout: 0 });
  assert.equal(result.acquired, false);
  assert.equal(result.code, 'BUSY');
  assert.equal(result.stale, true);
  assert.equal(readFileSync(path, 'utf8'), liveRecord, '现役锁必须原样保留');
  assert.deepEqual(renames, [], '不得移动锁文件');
});

test('显式解锁只清死亡进程锁，拒绝活锁与损坏锁', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = lockPath(root, 'demo');
  mkdirSync(dirname(path), { recursive: true });

  assert.deepEqual(clearStaleProjectLock(root, 'demo'), { status: 'absent', path });

  const live = acquireProjectLock(root, 'demo');
  const liveBytes = readFileSync(path, 'utf8');
  const held = clearStaleProjectLock(root, 'demo');
  assert.equal(held.status, 'held');
  assert.equal(held.owner.token, live.token);
  assert.equal(readFileSync(path, 'utf8'), liveBytes);
  releaseProjectLock(live);

  writeFileSync(path, '{"pid":1,"token"', 'utf8');
  const malformed = clearStaleProjectLock(root, 'demo');
  assert.equal(malformed.status, 'malformed');
  assert.equal(readFileSync(path, 'utf8'), '{"pid":1,"token"');
  rmSync(path, { force: true });

  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireProjectLock } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const lock = acquireProjectLock(process.argv[1], 'demo');
    process.stdout.write(lock.token);
    setInterval(() => {}, 1000);
  `, root], { stdio: ['ignore', 'pipe', 'ignore'] });
  let staleToken = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('持锁子进程未输出令牌')), 5000);
    holder.stdout.on('data', (chunk) => { clearTimeout(timer); staleToken += chunk; resolve(); });
    holder.stdout.on('error', reject);
  });
  holder.kill('SIGKILL');
  await waitForExit(holder);
  writeFileSync(path, `${JSON.stringify({ pid: holder.pid, token: staleToken, acquiredAt: Date.now() })}\n`, 'utf8');

  const cleared = clearStaleProjectLock(root, 'demo');
  assert.equal(cleared.status, 'cleared');
  assert.equal(cleared.owner.token, staleToken);
  assert.equal(existsSync(path), false);
  assert.equal(clearStaleProjectLock(root, 'demo').status, 'absent');
});

test('解锁前锁被替换则放弃，不删后继锁', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = lockPath(root, 'demo');
  mkdirSync(dirname(path), { recursive: true });
  const liveRecord = `${JSON.stringify({ pid: process.pid, token: 'fixture-live', acquiredAt: Date.now() })}\n`;
  writeFileSync(path, liveRecord, 'utf8');

  const source = readFileSync(modulePath, 'utf8');
  const expanded = source
    .replace(/\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g, (_, bindings, spec) => `const ${bindings.trim()} = __imports[${JSON.stringify(spec)}];`)
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/g, '');
  const realFs = await import('node:fs');
  let reads = 0;
  const unlinks = [];
  const proxy = new Proxy({}, {
    get(_, name) {
      if (name === 'readFileSync') {
        return (file, ...args) => {
          if (file === path) {
            reads += 1;
            if (reads === 1) return JSON.stringify({ pid: 999999, token: 'fixture-dead', acquiredAt: 0 });
          }
          return realFs.readFileSync(file, ...args);
        };
      }
      if (name === 'unlinkSync') {
        return (file) => {
          unlinks.push(String(file));
          return realFs.unlinkSync(file);
        };
      }
      return realFs[name];
    },
  });
  const context = createContext({
    __imports: { 'node:fs': proxy, 'node:path': nodePath, 'node:crypto': nodeCrypto },
    process: { pid: process.pid, ppid: process.ppid, kill: (pid, signal) => process.kill(pid, signal) },
    Atomics, SharedArrayBuffer, Date,
  });
  const api = new Script(`${expanded}\n;({ clearStaleProjectLock });`).runInContext(context);
  const result = api.clearStaleProjectLock(root, 'demo');
  assert.equal(result.status, 'changed');
  assert.deepEqual(unlinks, []);
  assert.equal(readFileSync(path, 'utf8'), liveRecord, '后继锁必须原样保留');
});

test('无令牌的损坏锁保持 BUSY，不被回收删除', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = lockPath(root, 'demo');
  mkdirSync(dirname(path), { recursive: true });
  const content = `${JSON.stringify({ pid: 999999, acquiredAt: 0 })}\n`;
  writeFileSync(path, content);
  const result = acquireProjectLock(root, 'demo');
  assert.equal(result.code, 'BUSY');
  assert.equal(readFileSync(path, 'utf8'), content);
});

test('审计包写入是整文件替换，保留无关文件且不留下临时文件', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = { project: { id: 'demo' }, version: 2, hashes: { facts: 'sha256:' + 'a'.repeat(64) } };
  writeBundle(root, bundle);
  writeDerivedFile(root, 'demo', 'audit.md', '# old');
  mkdirSync(join(root, 'data', 'demo'), { recursive: true });
  writeFileSync(join(root, 'data', 'demo', 'brief-history.json'), '[{"keep":true}]');
  writeBundleFiles(root, { ...bundle, version: 3 }, { 'audit.md': '# new' });
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'demo', 'bundle.pm.json'), 'utf8')).version, 3);
  assert.equal(readFileSync(join(root, 'data', 'demo', 'audit.md'), 'utf8'), '# new');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'demo', 'brief-history.json'), 'utf8')), [{ keep: true }]);
  assert.deepEqual(readdirSync(join(root, 'data', 'demo')).filter((name) => name.includes('.tmp')), []);
  assert.throws(() => writeDerivedFile(root, 'demo', '../escape.md', 'x'), /文件名无效/);
  assert.throws(() => writeBundle(root, { project: { id: '../evil' } }), /id 无效/);
});

test('代次清单校验和能发现同指纹的派生文件半写', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = { project: { id: 'demo' }, version: 2, hashes: { facts: 'sha256:' + 'a'.repeat(64) } };
  writeBundleFiles(root, bundle, { 'audit.md': '# ok' });
  writeAuditGeneration(root, 'demo', bundle.hashes.facts, ['bundle.pm.json', 'audit.md']);
  assert.equal(auditGenerationComplete(root, 'demo', bundle.hashes.facts), true);
  writeFileSync(join(root, 'data', 'demo', 'audit.md'), '# truncated', 'utf8');
  assert.equal(auditGenerationComplete(root, 'demo', bundle.hashes.facts), false);
  writeFileSync(join(root, 'data', 'demo', 'audit.md'), '# ok', 'utf8');
  assert.equal(auditGenerationComplete(root, 'demo', bundle.hashes.facts), true);
  assert.equal(auditGenerationComplete(root, 'demo', 'sha256:' + 'b'.repeat(64)), false);
  rmSync(join(root, 'data', 'demo', 'audit.md'));
  assert.equal(auditGenerationComplete(root, 'demo', bundle.hashes.facts), false);
});

test('保留文件名不能被派生写入', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => writeDerivedFile(root, 'demo', 'bundle.pm.json', 'x'), /文件名无效/);
  assert.throws(() => writeDerivedFile(root, 'demo', GENERATION_FILE, 'x'), /文件名无效/);
});

test('recordAuditBundle 首次审计会真正落盘，且与检查点指纹一致', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hash = 'sha256:' + 'c'.repeat(64);
  const bundle = { project: { id: 'demo' }, version: 2, hashes: { facts: hash } };
  recordAuditBundle(root, 'demo', 'cli', bundle, { 'audit.md': '# first' });
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'demo', 'bundle.pm.json'), 'utf8')).hashes.facts, hash);
  const state = JSON.parse(readFileSync(join(root, 'cache', 'demo', 'watch-state.json'), 'utf8'));
  assert.equal(state.auditedHash, hash);
  assert.equal(existsSync(lockPath(root, 'demo')), false);

  const next = 'sha256:' + 'd'.repeat(64);
  recordAuditBundle(root, 'demo', 'cli', { ...bundle, hashes: { facts: next } }, { 'audit.md': '# second' });
  assert.equal(JSON.parse(readFileSync(join(root, 'data', 'demo', 'bundle.pm.json'), 'utf8')).hashes.facts, next);
  assert.equal(JSON.parse(readFileSync(join(root, 'cache', 'demo', 'watch-state.json'), 'utf8')).auditedHash, next);
});

test('审计包原子写失败时旧包字节不变、派生文件不变、无临时残留', async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'data', 'demo');
  mkdirSync(dir, { recursive: true });
  const bundlePath = join(dir, 'bundle.pm.json');
  const oldBytes = 'old-bundle-bytes\n';
  writeFileSync(bundlePath, oldBytes, 'utf8');
  writeFileSync(join(dir, 'audit.md'), '# old', 'utf8');
  const stateBefore = `${JSON.stringify({ auditedHash: 'sha256:' + '1'.repeat(64) })}\n`;
  mkdirSync(join(root, 'cache', 'demo'), { recursive: true });
  writeFileSync(join(root, 'cache', 'demo', 'watch-state.json'), stateBefore, 'utf8');

  const source = readFileSync(modulePath, 'utf8');
  const expanded = source
    .replace(/\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g, (_, bindings, spec) => `const ${bindings.trim()} = __imports[${JSON.stringify(spec)}];`)
    .replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/g, '');
  const realFs = await import('node:fs');
  const proxy = new Proxy({}, {
    get(_, name) {
      if (name === 'renameSync') {
        return (from, to) => {
          if (String(to).endsWith('bundle.pm.json')) {
            throw Object.assign(new Error('fixture write failure'), { code: 'EIO' });
          }
          return realFs.renameSync(from, to);
        };
      }
      return realFs[name];
    },
  });
  const context = createContext({
    __imports: { 'node:fs': proxy, 'node:path': nodePath, 'node:crypto': nodeCrypto },
    process: { pid: process.pid, ppid: process.ppid, kill: (pid, signal) => process.kill(pid, signal) },
    Atomics, SharedArrayBuffer, Date,
  });
  const api = new Script(`${expanded}\n;({ writeBundleFiles });`).runInContext(context);
  assert.throws(() => api.writeBundleFiles(root, { project: { id: 'demo' } }, { 'audit.md': '# new' }), /fixture write failure/);
  assert.equal(readFileSync(bundlePath, 'utf8'), oldBytes, '旧包字节必须完好');
  assert.equal(readFileSync(join(dir, 'audit.md'), 'utf8'), '# old', '包写失败不得改动派生文件');
  assert.equal(readFileSync(join(root, 'cache', 'demo', 'watch-state.json'), 'utf8'), stateBefore, '包写失败不得推进检查点');
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp')), []);
});

test('writeAtomicFile 覆盖已有文件且不残留临时文件', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'a.json');
  writeFileSync(file, 'old', 'utf8');
  writeAtomicFile(file, 'new');
  assert.equal(readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
});

test('writeAtomicFile 目标不可替换时保留原内容且无临时残留', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'x');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'keep.txt'), 'old', 'utf8');
  assert.throws(() => writeAtomicFile(target, 'new'));
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'old');
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
});

test('包已更新但检查点未推进时状态可识别为不一致', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldHash = 'sha256:' + '3'.repeat(64);
  const newHash = 'sha256:' + '4'.repeat(64);
  const oldBundle = { project: { id: 'demo' }, version: 2, hashes: { facts: oldHash } };
  recordAuditBundle(root, 'demo', 'cli', oldBundle, {});

  writeBundle(root, { ...oldBundle, hashes: { facts: newHash } });
  const state = JSON.parse(readFileSync(join(root, 'cache', 'demo', 'watch-state.json'), 'utf8'));
  const bundle = JSON.parse(readFileSync(join(root, 'data', 'demo', 'bundle.pm.json'), 'utf8'));
  assert.equal(bundle.hashes.facts, newHash, '包已是新的');
  assert.equal(state.auditedHash, oldHash, '检查点仍是旧的');
  assert.notEqual(state.auditedHash, bundle.hashes.facts, '该不一致必须可被识别，交给下一轮入口恢复');
});

test('recordAuditBundle 在他人持锁时抛 BUSY，不写包也不推进检查点', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hash = 'sha256:' + 'e'.repeat(64);
  const bundle = { project: { id: 'demo' }, version: 2, hashes: { facts: hash } };
  const holder = acquireProjectLock(root, 'demo');
  assert.throws(() => recordAuditBundle(root, 'demo', 'cli', bundle, {}), { code: 'BUSY' });
  assert.equal(existsSync(join(root, 'data', 'demo', 'bundle.pm.json')), false);
  assert.equal(existsSync(join(root, 'cache', 'demo', 'watch-state.json')), false);
  releaseProjectLock(holder);
});

test('真实 CLI 审计在隔离工作区首次与再次都落盘，外部持锁时返回 BUSY 且不写包', { timeout: 20000 }, async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  for (const name of readdirSync(join(repo, 'src'))) {
    if (name.endsWith('.mjs')) copyFileSync(join(repo, 'src', name), join(root, 'src', name));
  }
  for (const name of readdirSync(join(repo, 'bin'))) {
    if (name.endsWith('.mjs')) copyFileSync(join(repo, 'bin', name), join(root, 'bin', name));
  }
  const projectDir = join(root, 'projects', 'demo');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
    id: 'demo', name: 'Demo', repo: 'fixture/never-contact', localRepo: null,
    defaultBranch: 'main', admin: null, members: {}, staleDays: 5,
    activeWindowDays: 14, commitWindowDays: 30, plan: 'plan.json', planSource: 'fixture',
  }, null, 2));
  writeFileSync(join(projectDir, 'plan.json'), JSON.stringify({
    nodes: [{ id: 'N1', owner: 'A', est: 'S', title: '示例节点', deps: [], files: [], acceptance: '完成' }],
  }, null, 2));
  const raw = {
    fetchedAt: '2026-11-20T10:00:00.000Z', repo: 'fixture/never-contact',
    issues: [], pulls: [], branches: [], branchCommits: [], pullDetails: {},
  };
  mkdirSync(join(root, 'cache', 'demo'), { recursive: true });
  writeFileSync(join(root, 'cache', 'demo', 'raw.json'), JSON.stringify(raw));

  copyFileSync(join(repo, 'test', 'lib', 'refresh-process.cjs'), join(root, 'preload.cjs'));
  writeFileSync(join(root, 'control.json'), '{}');
  const env = {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    TEMP: root, TMP: root, PATH: dirname(process.execPath), PM_TEST_ROOT: root,
    NODE_OPTIONS: `--require ${JSON.stringify(join(root, 'preload.cjs'))}`,
  };
  const cli = join(root, 'bin', 'pmctl.mjs');
  const first = execFileSync(process.execPath, [cli, 'audit', 'demo'], { encoding: 'utf8', cwd: root, env, timeout: 10000 });
  assert.match(first, /data\/demo\/bundle\.pm\.json/);
  const bundlePath = join(root, 'data', 'demo', 'bundle.pm.json');
  const firstBundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  assert.equal(firstBundle.project.id, 'demo');
  const firstHash = firstBundle.hashes.facts;
  const statePath = join(root, 'cache', 'demo', 'watch-state.json');
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).auditedHash, firstHash);

  writeFileSync(join(root, 'data', 'demo', 'unrelated.txt'), 'keep me');
  execFileSync(process.execPath, [cli, 'audit', 'demo'], { encoding: 'utf8', cwd: root, env, timeout: 10000 });
  assert.equal(readFileSync(join(root, 'data', 'demo', 'unrelated.txt'), 'utf8'), 'keep me');
  const secondHash = JSON.parse(readFileSync(bundlePath, 'utf8')).hashes.facts;
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).auditedHash, secondHash);

  const holder = acquireProjectLock(root, 'demo');
  let failed = null;
  try {
    execFileSync(process.execPath, [cli, 'audit', 'demo'], { encoding: 'utf8', cwd: root, env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    failed = err;
  }
  assert.ok(failed, '外部持锁时 CLI 必须失败');
  assert.equal(failed.status, 70);
  assert.match(String(failed.stderr), /另一个进程|BUSY/);
  assert.equal(JSON.parse(readFileSync(bundlePath, 'utf8')).hashes.facts, secondHash);
  releaseProjectLock(holder);

  const holder2 = acquireProjectLock(root, 'demo');
  let publishFailed = null;
  try {
    execFileSync(process.execPath, [cli, 'publish', 'demo'], { encoding: 'utf8', cwd: root, env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    publishFailed = err;
  }
  assert.ok(publishFailed, '外部持锁时 CLI 发布必须失败');
  assert.equal(publishFailed.status, 70);
  releaseProjectLock(holder2);
});
