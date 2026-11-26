import {
  mkdirSync, openSync, closeSync, readFileSync, unlinkSync, rmSync,
  writeFileSync, renameSync, fsyncSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const PROJECT_LOCK_RETRY_MS = 200;
export const PROJECT_LOCK_TIMEOUT = 0;
export const GENERATION_FILE = '.audit-generation.json';

const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_FILE_NAMES = new Set(['bundle.pm.json', GENERATION_FILE]);

export function assertProjectId(id) {
  if (typeof id !== 'string' || !PROJECT_ID.test(id)) throw new Error('审计包项目 id 无效');
  return id;
}

export function projectLockPath(root, id) {
  assertProjectId(id);
  const base = resolve(root);
  const expected = join(base, 'cache', id, 'project.lock');
  const path = resolve(expected);
  const prefix = join(base, 'cache') + sep;
  if (path !== expected || !path.startsWith(prefix)) throw new Error('项目锁路径越界');
  return path;
}

function holderState(record) {
  if (!record || typeof record.pid !== 'number' || !Number.isInteger(record.pid)) return 'invalid';
  if (typeof record.token !== 'string' || !record.token) return 'invalid';
  if (record.pid <= 0) return 'invalid';
  try {
    process.kill(record.pid, 0);
    return 'alive';
  } catch (err) {
    if (err.code === 'EPERM') return 'alive';
    if (err.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function readLock(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export function acquireProjectLock(root, id, { timeout = PROJECT_LOCK_TIMEOUT, retryMs = PROJECT_LOCK_RETRY_MS } = {}) {
  const path = projectLockPath(root, id);
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + Math.max(0, timeout);
  const token = randomUUID();
  for (;;) {
    let created = false;
    try {
      const fd = openSync(path, 'wx');
      created = true;
      const acquiredAt = Date.now();
      try {
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, acquiredAt })}\n`, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { acquired: true, root: resolve(root), id, path, token, acquiredAt, pid: process.pid };
    } catch (err) {
      if (created) {
        try {
          rmSync(path, { force: true });
        } catch (cleanupErr) {
          if (cleanupErr.code !== 'ENOENT') throw cleanupErr;
        }
      }
      if (err.code !== 'EEXIST') throw err;
      const record = readLock(path);
      const state = holderState(record);
      if (state === 'dead') {
        return {
          acquired: false,
          code: 'BUSY',
          stale: true,
          owner: { pid: record.pid, token: record.token },
          error: Object.assign(new Error('项目锁持有者已退出；需人工确认后解锁'), { code: 'BUSY' }),
        };
      }
      if (state !== 'alive') {
        return {
          acquired: false,
          code: 'BUSY',
          error: Object.assign(new Error('项目锁记录无效或不可读，保持原样'), { code: 'BUSY' }),
        };
      }
      if (Date.now() >= deadline) {
        return {
          acquired: false,
          code: 'BUSY',
          error: Object.assign(new Error('项目正在由另一个进程处理'), { code: 'BUSY' }),
        };
      }
      const wait = Math.min(retryMs, Math.max(0, deadline - Date.now()));
      if (wait) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

export function clearStaleProjectLock(root, id) {
  const path = projectLockPath(root, id);
  const record = readLock(path);
  if (!record) {
    let present = true;
    try {
      readFileSync(path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') present = false;
      else throw err;
    }
    return present
      ? { status: 'malformed', path, error: '锁记录损坏或缺少有效令牌，未删除；请人工检查后处理' }
      : { status: 'absent', path };
  }
  const state = holderState(record);
  if (state === 'alive') {
    return {
      status: 'held', path, owner: { pid: record.pid, token: record.token },
      error: `持有者进程 ${record.pid} 仍存活，拒绝解锁`,
    };
  }
  if (state !== 'dead') {
    return { status: 'malformed', path, error: '锁记录无效或持有者状态无法确认，未删除；请人工检查后处理' };
  }
  const current = readLock(path);
  if (!current || current.token !== record.token) {
    return { status: 'changed', path, error: '锁在解锁前已被其他进程处理，放弃解锁' };
  }
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'absent', path };
    throw err;
  }
  return { status: 'cleared', path, owner: { pid: record.pid, token: record.token } };
}

export function assertProjectLock(root, id, lock) {
  const path = projectLockPath(root, id);
  const pid = lock?.delegated === true ? process.ppid : process.pid;
  if (lock?.acquired !== true || lock.root !== resolve(root) || lock.id !== id || lock.path !== path ||
      !Number.isInteger(pid) || pid <= 0 || lock.pid !== pid || typeof lock.token !== 'string' || !lock.token) {
    throw Object.assign(new Error('项目锁归属或父进程委托不匹配'), { code: 'LOCK_OWNERSHIP_MISMATCH' });
  }
  const record = readLock(path);
  if (record?.pid !== pid || record?.token !== lock.token || holderState(record) !== 'alive') {
    throw Object.assign(new Error('项目锁已失效或父进程委托不匹配'), { code: 'LOCK_OWNERSHIP_MISMATCH' });
  }
  return lock;
}

export function delegateProjectLock(lock) {
  if (lock?.delegated) throw Object.assign(new Error('不能再次委托父进程项目锁'), { code: 'LOCK_OWNERSHIP_MISMATCH' });
  assertProjectLock(lock.root, lock.id, lock);
  return JSON.stringify({ root: lock.root, id: lock.id, token: lock.token, pid: lock.pid });
}

export function acceptProjectLockDelegation(root, id, encoded) {
  let delegation;
  try { delegation = JSON.parse(encoded); } catch {}
  if (!delegation || delegation.root !== resolve(root) || delegation.id !== id || delegation.pid !== process.ppid) {
    throw Object.assign(new Error('父进程项目锁委托无效'), { code: 'LOCK_OWNERSHIP_MISMATCH' });
  }
  return assertProjectLock(root, id, {
    acquired: true, delegated: true, root: resolve(root), id, path: projectLockPath(root, id),
    token: delegation.token, pid: delegation.pid,
  });
}

export async function withProjectLock(root, id, operation, { lock = null } = {}) {
  if (lock) {
    assertProjectLock(root, id, lock);
    return operation(lock);
  }
  const owned = acquireProjectLock(root, id, { timeout: 0 });
  if (!owned.acquired) throw owned.error;
  try {
    return await operation(owned);
  } finally {
    releaseProjectLock(owned);
  }
}

export function releaseProjectLock(lock) {
  if (!lock || lock.acquired !== true || lock.delegated || lock.pid !== process.pid || typeof lock.token !== 'string') return false;
  try {
    if (readLock(lock.path)?.token !== lock.token) return false;
    unlinkSync(lock.path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export function readLockOwner(path) {
  return readLock(path)?.token ?? null;
}

export function writeAtomicFile(file, content) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, 'wx');
    try {
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return file;
}

export function writeJsonFile(file, value) {
  let content;
  try {
    content = JSON.stringify(value, null, 2);
  } catch (err) {
    throw new Error(`数据无法序列化：${err.message}`);
  }
  if (content.includes('\n')) content += '\n';
  return writeAtomicFile(file, content);
}

export function assertSafeFileName(name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') ||
      name === '.' || name === '..' || RESERVED_FILE_NAMES.has(name)) throw new Error('审计派生文件名无效');
  return name;
}

export function dataDir(root, id) {
  return join(resolve(root), 'data', assertProjectId(id));
}

export function writeBundle(root, bundle) {
  const id = assertProjectId(bundle?.project?.id);
  return writeJsonFile(join(dataDir(root, id), 'bundle.pm.json'), bundle);
}

export function writeDerivedFile(root, id, name, content) {
  assertProjectId(id);
  assertSafeFileName(name);
  return writeAtomicFile(join(dataDir(root, id), name), String(content));
}

export function writeBundleFiles(root, bundle, files = {}) {
  const written = [writeBundle(root, bundle)];
  for (const [name, content] of Object.entries(files)) {
    written.push(writeDerivedFile(root, bundle.project.id, name, content));
  }
  return written;
}

function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

function assertGenerationName(name) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') ||
      name === '.' || name === '..') throw new Error('代次文件名无效');
  return name;
}

export function writeAuditGeneration(root, id, hash, names) {
  const dir = dataDir(root, id);
  const files = names.map((name) => {
    const safe = assertGenerationName(name);
    return { name: safe, sha256: sha256File(join(dir, safe)) };
  });
  return writeJsonFile(join(dir, GENERATION_FILE), { hash, files });
}

export function auditGenerationComplete(root, id, hash) {
  const dir = dataDir(root, id);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, GENERATION_FILE), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  if (!manifest || manifest.hash !== hash || !Array.isArray(manifest.files)) return false;
  for (const entry of manifest.files) {
    if (typeof entry?.name !== 'string' || !entry.name || typeof entry?.sha256 !== 'string') return false;
    let actual;
    try {
      actual = sha256File(join(dir, entry.name));
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
    if (actual !== entry.sha256) return false;
  }
  return true;
}
