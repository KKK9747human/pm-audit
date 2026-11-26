import { readFileSync, writeFileSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  acquireProjectLock, releaseProjectLock, writeBundleFiles, assertProjectLock,
  writeAuditGeneration, auditGenerationComplete,
} from './project-lock.mjs';
import { loadBundle, verifyBundle } from './bundle.mjs';

export const STATE_FILES = {
  server: 'refresh-state.json',
  cli: 'watch-state.json',
};

function stateLock(root, id, lock) {
  if (lock) {
    assertProjectLock(root, id, lock);
    return null;
  }
  const owned = acquireProjectLock(root, id, { timeout: 0 });
  if (!owned.acquired) throw owned.error;
  return owned;
}

function withStateLock(root, id, lock, write) {
  const owned = stateLock(root, id, lock);
  try {
    return write(owned || lock);
  } finally {
    if (owned) releaseProjectLock(owned);
  }
}

async function withStateLockAsync(root, id, lock, write) {
  const owned = stateLock(root, id, lock);
  try {
    return await write(owned || lock);
  } finally {
    if (owned) releaseProjectLock(owned);
  }
}

export function statePath(root, id, kind) {
  return join(root, 'cache', id, STATE_FILES[kind] || kind);
}

export function readState(root, id, kind) {
  try {
    return JSON.parse(readFileSync(statePath(root, id, kind), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function applyAuditConsistency(decision, consistency) {
  if (!consistency?.mismatch) return decision;
  return { ...decision, refresh: true, reason: consistency.reason };
}

export function auditConsistency(root, id, state) {
  const checkpoint = state?.auditedHash || null;
  let bundle = null;
  let loadError = null;
  try {
    bundle = loadBundle(root, id);
  } catch (err) {
    loadError = err;
  }
  const hash = bundle?.hashes?.facts || null;
  if (loadError) {
    return {
      mismatch: true, hash, checkpoint, bundle, loadError,
      reason: `审计包无法读取：${loadError.message}`,
    };
  }
  if (!checkpoint) return { mismatch: false, hash, checkpoint, bundle };
  if (!hash) {
    return { mismatch: true, hash, checkpoint, bundle, reason: '审计包缺失，但检查点已有指纹' };
  }
  if (hash === checkpoint) {
    try {
      if (!verifyBundle(bundle).ok) {
        return { mismatch: true, hash, checkpoint, bundle, reason: '审计包声明指纹与内容不自洽' };
      }
    } catch (err) {
      return { mismatch: true, hash, checkpoint, bundle, reason: `审计包校验失败：${err.message}` };
    }
    if (!auditGenerationComplete(root, id, hash)) {
      return { mismatch: true, hash, checkpoint, bundle, reason: '审计包代次清单缺失或文件校验不符' };
    }
    return { mismatch: false, hash, checkpoint, bundle };
  }
  if (state?.pendingPublish?.hash && state.pendingPublish.hash === hash) {
    return { mismatch: false, hash, checkpoint, bundle, reason: 'pending 发布记录与当前包一致' };
  }
  return {
    mismatch: true, hash, checkpoint, bundle,
    reason: `审计包指纹与检查点不一致（${hash} ≠ ${checkpoint}）`,
  };
}

export function writeState(root, id, kind, state) {
  mkdirSync(join(root, 'cache', id), { recursive: true });
  const path = statePath(root, id, kind);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx');
    try {
      writeFileSync(fd, JSON.stringify(state, null, 2), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return state;
}

export function pendingOf(state) {
  const pending = state?.pendingPublish;
  return pending && typeof pending === 'object' && pending.hash ? pending : null;
}

export function pendingNeedsAudit(state, hash) {
  const pending = pendingOf(state);
  return Boolean(pending && pending.hash !== hash);
}

export function pendingDecision({ state, hash, allowPublish }) {
  const pending = pendingOf(state);
  if (!pending) return { publish: false, reason: '没有待发布任务', audit: false };
  if (!allowPublish) return { publish: false, reason: '当前入口不允许发布，等待已授权的写回入口', audit: false };
  return { publish: true, reason: '上次发布未完成，重试', audit: pending.hash !== hash, pending };
}

export function recordObservation(root, id, kind, { signature, probe }, lock = null) {
  return withStateLock(root, id, lock, (held) => {
    const prev = readState(root, id, kind) || {};
    return writeState(root, id, kind, {
      ...prev,
      observedSignature: signature,
      observedProbe: probe,
      lastObservedAt: new Date().toISOString(),
    });
  });
}

export function recordAudit(root, id, kind, { hash, signature = null, probe = null, publish = false }, lock = null) {
  return withStateLock(root, id, lock, () => {
    const prev = readState(root, id, kind) || {};
    const now = new Date().toISOString();
    const next = {
      ...prev,
      auditedHash: hash,
      auditedSignature: signature,
      auditedProbe: probe,
      lastAuditedAt: now,
    };
    if (publish) {
      next.pendingPublish = {
        hash, signature, attemptId: null, updatedAt: now,
        attempts: prev.pendingPublish?.hash === hash ? prev.pendingPublish.attempts || 0 : 0,
      };
    }
    return writeState(root, id, kind, next);
  });
}

export function recordAuditBundle(root, id, kind, bundle, files, {
  signature = null, probe = null, publish = false, lock = null,
} = {}) {
  return withStateLock(root, id, lock, (held) => {
    writeBundleFiles(root, bundle, files);
    writeAuditGeneration(root, bundle.project.id, bundle.hashes.facts, ['bundle.pm.json', ...Object.keys(files)]);
    return kind === null ? null : recordAudit(root, id, kind, { hash: bundle.hashes.facts, signature, probe, publish }, held);
  });
}

export function recordPending(root, id, kind, { hash, signature = null, error = null }, lock = null) {
  return withStateLock(root, id, lock, () => {
    const prev = readState(root, id, kind) || {};
    const pending = {
      hash,
      signature,
      attemptId: randomUUID(),
      updatedAt: new Date().toISOString(),
      attempts: (prev.pendingPublish?.hash === hash ? prev.pendingPublish.attempts || 0 : 0) + 1,
    };
    if (error) pending.lastError = String(error).slice(0, 300);
    return writeState(root, id, kind, { ...prev, pendingPublish: pending });
  });
}

export function recordPublishResult(root, id, kind, { hash, confirmedHash, attemptId, result, error = null, commit = null, parent = null }, lock = null) {
  return withStateLock(root, id, lock, () => {
    const prev = readState(root, id, kind) || {};
    const pending = pendingOf(prev);
    if (!attemptId || pending?.attemptId !== attemptId || pending.hash !== hash) return prev;
    const next = { ...prev };
    const success = result === 'published' || result === 'same';
    if (success && confirmedHash === hash) {
      delete next.pendingPublish;
      next.publishedHash = hash;
      next.publishedSignature = pending.signature;
      next.publishedAt = new Date().toISOString();
      if (commit) {
        next.publishedCommit = commit;
        next.publishedParent = parent;
        next.publishedHeadSha = commit;
        next.publishedCommits = [...new Set([...(prev.publishedCommits || []), commit])].slice(-100);
      }
    } else {
      next.pendingPublish = {
        ...pending,
        updatedAt: new Date().toISOString(),
        lastError: String(success ? '发布回执指纹与待发布数据包不一致' : error || result || '发布失败').slice(0, 300),
      };
    }
    return writeState(root, id, kind, next);
  });
}

export async function publishPending(root, project, bundle, { kind, signature = null, publish }, lock = null) {
  return withStateLockAsync(root, project.id, lock, async (held) => {
    const hash = bundle.hashes.facts;
    const state = recordPending(root, project.id, kind, { hash, signature }, held);
    let result;
    try {
      result = await publish(bundle);
      if (!['published', 'same'].includes(result?.status) || result.hash !== hash) {
        const err = new Error('发布回执未确认目标数据包，保留待发布任务');
        err.code = 'PUBLISH_IDENTITY_MISMATCH';
        throw err;
      }
    } catch (err) {
      result = { status: 'error', hash, error: String(err.message).slice(0, 300), code: err.code || null, conflict: err.code === 'CONFLICT' };
    }
    recordPublishResult(root, project.id, kind, {
      hash,
      confirmedHash: result.hash,
      attemptId: state.pendingPublish.attemptId,
      result: result.status,
      error: result.error,
      commit: result.commit,
      parent: result.parent,
    }, held);
    return result;
  });
}

export async function reconcilePending(root, project, { kind, hash, attemptId, confirm }, lock = null) {
  const pending = withStateLock(root, project.id, lock, () => {
    const current = pendingOf(readState(root, project.id, kind));
    if (!attemptId || current?.attemptId !== attemptId || current.hash !== hash) return null;
    return current;
  });
  if (!pending) return { status: 'skipped' };
  let result;
  try {
    result = await confirm(project, hash);
    if (result?.status === 'absent' || result?.status === 'not-match') return result;
    if (result?.status !== 'confirmed' || result.hash !== hash ||
        !/^[0-9a-f]{40}$/i.test(result.commit || '') || !/^[0-9a-f]{40}$/i.test(result.parent || '') ||
        result.commit === result.parent) {
      const err = new Error('远端确认未验证待发布身份，保留待发布任务');
      err.code = 'PUBLISH_IDENTITY_MISMATCH';
      throw err;
    }
  } catch (err) {
    withStateLock(root, project.id, lock, (held) => {
      recordPublishResult(root, project.id, kind, { hash, attemptId, result: 'error', error: err.message }, held);
    });
    throw err;
  }
  return withStateLock(root, project.id, lock, (held) => {
    const current = pendingOf(readState(root, project.id, kind));
    if (current?.attemptId !== attemptId || current.hash !== hash) return { status: 'skipped' };
    recordPublishResult(root, project.id, kind, {
      hash, attemptId, confirmedHash: result.hash, result: 'same', commit: result.commit, parent: result.parent,
    }, held);
    return result;
  });
}

export function knownOwnCommits(state) {
  return new Set([...(state?.publishedCommits || []), state?.publishedCommit]
    .filter((commit) => typeof commit === 'string' && /^[0-9a-f]{40}$/i.test(commit)));
}
