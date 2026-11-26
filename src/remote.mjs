import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ghJson } from './gh.mjs';
import { hashOf } from './canonical.mjs';
import { verifyBundle, saveBundle, loadBundle } from './bundle.mjs';
import { buildAgent, writeAgentLocal } from './agent.mjs';
import { renderTrail } from './trail.mjs';
import { detectIdentity, isAdmin, adminDenied, adminList } from './identity.mjs';
import { createProject, getProject } from './project.mjs';
import { fileHash, shortHash } from './brand.mjs';
import { withProjectLock, writeJsonFile } from './project-lock.mjs';

export function pmRoot(project) {
  return `.pm/${project.id}`;
}

export function readBranchSnapshot(project, branch = project.defaultBranch || 'main') {
  return ghJson(`repos/${project.repo}/git/ref/heads/${encodeURIComponent(branch)}`, { retries: 2 });
}

export function readCommitSnapshot(project, sha) {
  return ghJson(`repos/${project.repo}/git/commits/${sha}`, { retries: 2 });
}

export function isFullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function isNotFound(err) {
  if (err?.name === 'SyntaxError') return false;
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status != null) return Number(status) === 404;
  return /\bHTTP(?:\/[\d.]+)?\s+404\b/i.test(String(err?.message || ''));
}

function invalidRemote(message, cause) {
  const err = new Error(message, { cause });
  err.code = 'INVALID_REMOTE_DATA';
  return err;
}

function isScopedPath(path, prefix) {
  return typeof path === 'string' && path.startsWith(prefix) &&
    !/[\\\x00-\x1f%?#]/.test(path) &&
    path.slice(prefix.length).split('/').every((part) => part && part !== '.' && part !== '..');
}

function decodeBase64(value) {
  if (typeof value !== 'string') throw invalidRemote('远端缺少 base64 内容');
  const text = value.replace(/\s/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw invalidRemote('远端 base64 内容无效');
  }
  return Buffer.from(text, 'base64');
}

async function contents(project, relPath, { retries = 2, ref } = {}) {
  const branch = encodeURIComponent(ref || project.defaultBranch || 'main');
  let j;
  try {
    j = await ghJson(`repos/${project.repo}/contents/${relPath}?ref=${branch}`, { retries });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  if (!j || Array.isArray(j)) throw invalidRemote(`远端文件响应无效: ${relPath}`);
  let payload = j;
  if ((typeof j.content !== 'string' || j.encoding === 'none') && j.sha) {
    // A missing referenced blob is corrupt data, not an absent file.
    try {
      payload = await ghJson(`repos/${project.repo}/git/blobs/${j.sha}`, { retries });
    } catch (err) {
      if (isNotFound(err)) throw invalidRemote(`远端文件 blob 缺失: ${relPath}`, err);
      throw err;
    }
  }
  if (payload?.encoding && payload.encoding !== 'base64') throw invalidRemote(`远端文件编码无效: ${relPath}`);
  return { text: decodeBase64(payload?.content).toString('utf8'), sha: j.sha };
}

async function contentsB64(project, relPath, opts = {}) {
  const file = await contents(project, relPath, opts);
  return file ? file.text : null;
}

export async function fetchRemoteManifest(project, opts) {
  const f = await contents(project, `${pmRoot(project)}/manifest.json`, opts);
  if (!f) return null;
  let manifest;
  try {
    manifest = JSON.parse(f.text);
  } catch (err) {
    throw invalidRemote('远端 manifest JSON 无效', err);
  }
  if (!manifest || manifest.format !== 'pm-audit/remote' || manifest.version !== 1 ||
      manifest.project !== project.id || !/^sha256:[0-9a-f]{64}$/.test(manifest.hash || '') ||
      typeof manifest.asOf !== 'string' || !Number.isFinite(Date.parse(manifest.asOf)) ||
      (manifest.files !== undefined && (!manifest.files || typeof manifest.files !== 'object' ||
        Array.isArray(manifest.files) || Object.values(manifest.files).some((hash) => typeof hash !== 'string')))) {
    throw invalidRemote('远端 manifest 格式或项目不匹配');
  }
  if (manifest.bundle !== undefined) {
    const descriptor = manifest.bundle;
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) ||
        typeof descriptor.format !== 'string' || !descriptor.format ||
        (descriptor.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(descriptor.sha256)) ||
        ((descriptor.parts !== undefined || descriptor.format === 'gzip-base64-parts') && (descriptor.format !== 'gzip-base64-parts' ||
          !Array.isArray(descriptor.parts) || !descriptor.parts.length ||
          descriptor.parts.some((rel) => typeof rel !== 'string' || !isScopedPath(`${pmRoot(project)}/${rel}`, `${pmRoot(project)}/`))))) {
      throw invalidRemote('远端 manifest 数据包描述无效');
    }
  }
  return manifest;
}

const BUNDLE_PART_CHARS = 48000;

async function lastPmCommit(project, { ref, ...opts } = {}) {
  const branch = encodeURIComponent(ref || project.defaultBranch || 'main');
  const path = encodeURIComponent(`${pmRoot(project)}/manifest.json`);
  const j = await ghJson(`repos/${project.repo}/commits?path=${path}&sha=${branch}&per_page=1`, opts);
  if (!Array.isArray(j)) throw invalidRemote('远端提交来源响应无效');
  const c = j[0];
  if (!c) return null;
  return {
    sha: c.sha,
    author: typeof c.author?.login === 'string' ? c.author.login.trim() : null,
    authorName: c.commit?.author?.name || null,
    date: c.commit?.author?.date || null,
  };
}

export async function fetchRemoteBundle(project, { manifest, ...opts } = {}) {
  const man = manifest || (await fetchRemoteManifest(project, opts));
  if (!man) return null;
  if (man.bundle?.parts?.length) {
    const chunks = await mapLimit(man.bundle.parts, 4, async (rel) => {
      if (!isScopedPath(`${pmRoot(project)}/${rel}`, `${pmRoot(project)}/`)) throw invalidRemote('远端分片路径无效');
      const b64 = await contentsB64(project, `${pmRoot(project)}/${rel}`, { retries: 3, ...opts });
      return b64 ? b64.replace(/\s/g, '') : null;
    });
    if (chunks.some((c) => !c)) throw invalidRemote('远端数据包分片缺失');
    const gz = decodeBase64(chunks.join(''));
    if (man.bundle.sha256 && createHash('sha256').update(gz).digest('hex') !== man.bundle.sha256) {
      throw invalidRemote('远端数据包压缩指纹不匹配');
    }
    try {
      return JSON.parse(gunzipSync(gz).toString('utf8'));
    } catch (err) {
      throw invalidRemote('远端数据包压缩内容或 JSON 无效', err);
    }
  }
  const gzB64 = await contentsB64(project, `${pmRoot(project)}/bundle.pm.json.gz`, { retries: 2, ...opts });
  if (gzB64 !== null) {
    try {
      return JSON.parse(gunzipSync(decodeBase64(gzB64)).toString('utf8'));
    } catch (err) {
      throw invalidRemote('远端数据包压缩内容或 JSON 无效', err);
    }
  }
  const f = await contents(project, `${pmRoot(project)}/bundle.pm.json`, { retries: 1, ...opts });
  if (!f) throw invalidRemote('远端 manifest 引用的数据包缺失');
  try {
    return JSON.parse(f.text);
  } catch (err) {
    throw invalidRemote('远端数据包 JSON 无效', err);
  }
}

const BUNDLE_INVALID_REASONS = {
  bundle_format: '数据包格式或版本不支持',
  project_id: '数据包项目与当前项目不一致',
  repo: '数据包仓库与当前项目不一致',
  as_of: '数据包审计时间无效',
  facts_declared: '包内 facts 自身指纹与声明不一致',
  facts_recompute: '依据计划与证据重算的事实指纹与包内声明不一致',
  manifest: '远端 manifest 与数据包指纹或项目不一致',
};

function invalidBundle(reason, stage, extra = {}) {
  const err = new Error(`数据包校验失败：${BUNDLE_INVALID_REASONS[reason] || '未知原因'}`);
  err.code = 'INVALID_BUNDLE';
  err.reason = reason;
  err.stage = stage;
  Object.assign(err, extra);
  return err;
}

export function validateProjectBundle(project, bundle, manifest) {
  if (bundle.project?.id !== project.id) {
    throw invalidBundle('project_id', 'project', { expected: project.id, actual: bundle.project?.id ?? null });
  }
  if (typeof bundle.project?.repo !== 'string' || bundle.project.repo.toLowerCase() !== project.repo.toLowerCase()) {
    throw invalidBundle('repo', 'project', { expected: project.repo, actual: bundle.project?.repo ?? null });
  }
  if (typeof bundle.asOf !== 'string' || !Number.isFinite(Date.parse(bundle.asOf))) {
    throw invalidBundle('as_of', 'project', { expected: '有效时间', actual: typeof bundle.asOf === 'string' ? bundle.asOf : null });
  }
  let check;
  try {
    check = verifyBundle(bundle);
  } catch (err) {
    throw invalidBundle('bundle_format', 'verifyBundle', { expected: null, actual: null, detail: String(err.message).slice(0, 160) });
  }
  const declared = hashOf(bundle.facts);
  if (declared !== bundle.hashes?.facts) {
    throw invalidBundle('facts_declared', 'facts', { expected: bundle.hashes?.facts || null, actual: declared, declared });
  }
  if (check.actual !== bundle.hashes?.facts) {
    throw invalidBundle('facts_recompute', 'facts', { expected: bundle.hashes?.facts || null, actual: check.actual, declared });
  }
  if (manifest && (manifest.project !== bundle.project.id || manifest.hash !== bundle.hashes.facts)) {
    throw invalidBundle('manifest', 'manifest', { expected: manifest?.hash || null, actual: bundle.hashes?.facts || null });
  }
  return check;
}

export async function confirmRemotePublish(project, hash) {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash || '')) throw invalidRemote('待确认的数据包指纹无效');
  const snapshot = await readBranchSnapshot(project);
  const ref = snapshot?.object?.sha;
  if (!isFullSha(ref)) throw invalidRemote('远端分支快照不完整');
  const opts = { retries: 1, ref };
  const manifest = await fetchRemoteManifest(project, opts);
  if (!manifest) return { status: 'absent' };
  if (manifest.hash !== hash) return { status: 'not-match', hash: manifest.hash };
  const last = await lastPmCommit(project, opts);
  if (!last?.author || !isFullSha(last.sha) ||
      !adminList(project).some((admin) => admin.toLowerCase() === last.author.toLowerCase())) {
    const err = new Error('远端数据包提交来源不可信，未确认发布');
    err.code = 'UNTRUSTED_REMOTE';
    throw err;
  }
  const bundle = await fetchRemoteBundle(project, { manifest, ...opts });
  validateProjectBundle(project, bundle, manifest);
  const commit = await readCommitSnapshot(project, last.sha);
  if (commit?.sha !== last.sha || !Array.isArray(commit.parents) || commit.parents.length !== 1 ||
      !isFullSha(commit.parents[0]?.sha) || commit.parents[0].sha === last.sha) {
    throw invalidRemote('远端数据包提交或父提交不完整');
  }
  return { status: 'confirmed', hash, commit: last.sha, parent: commit.parents[0].sha };
}

export async function syncFromRemote(root, project, { lock = null } = {}) {
  const snapshot = await readBranchSnapshot(project);
  const ref = snapshot?.object?.sha;
  if (!isFullSha(ref)) return { status: 'invalid', error: '远端分支快照不完整' };
  const opts = { retries: 1, ref };
  let manifest;
  let bundle;
  try {
    manifest = await fetchRemoteManifest(project, opts);
    if (!manifest) return { status: 'absent' };
    const last = await lastPmCommit(project, opts);
    const admins = adminList(project);
    if (!last?.author || !isFullSha(last.sha) || !admins.some((a) => a.toLowerCase() === last.author.toLowerCase())) {
      return {
        status: 'untrusted',
        expectedAdmin: admins.join('、'),
        author: last?.author || null,
        authorName: last?.authorName || null,
        commit: last?.sha || null,
      };
    }
    bundle = await fetchRemoteBundle(project, { manifest, ...opts });
  } catch (err) {
    if (err.code === 'INVALID_REMOTE_DATA' || err.name === 'SyntaxError') return { status: 'invalid', error: err.message };
    throw err;
  }
  try {
    validateProjectBundle(project, bundle, manifest);
  } catch (err) {
    return { status: 'invalid', error: err.message, expected: err.expected, actual: err.actual, reason: err.reason || null, stage: err.stage || null };
  }
  return withProjectLock(root, project.id, () => {
    // An advertised matching hash does not validate a legacy or damaged local bundle.
    try {
      const local = loadBundle(root, project.id);
      if (local?.hashes?.facts === manifest.hash) {
        validateProjectBundle(project, local, manifest);
        return { status: 'same', hash: manifest.hash, asOf: manifest.asOf };
      }
    } catch {} // A verified remote bundle may repair an invalid local copy.
    saveBundle(root, bundle);
    try {
      writeAgentLocal(root, project, bundle, detectIdentity(project));
    } catch {}
    return {
      status: 'updated',
      hash: bundle.hashes.facts,
      asOf: bundle.asOf,
      remoteCommit: ref,
    };
  }, { lock });
}

async function listRemoteDirs(repo, branch, relPath, retries = 3) {
  try {
    const j = await ghJson(`repos/${repo}/contents/${relPath}?ref=${encodeURIComponent(branch)}`, { retries });
    return Array.isArray(j) ? j.filter((e) => e.type === 'dir').map((e) => e.name) : [];
  } catch {
    return [];
  }
}

// 新机器接管已有项目：只读远端 .pm/<id>/，校验后在本机建项目并保存数据包。
export async function adoptFromRemote(root, { repo, id, branch = 'main', dryRun = false, retries = 3, log = () => {}, lock = null } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Error('仓库地址必须是 owner/name 形式');
  let target = id || null;
  if (!target) {
    const dirs = (await listRemoteDirs(repo, branch, '.pm', retries)).filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n));
    if (!dirs.length) throw new Error(`远端 ${repo} 的 .pm/ 下没有可用项目`);
    if (dirs.length > 1) throw new Error(`远端有多个项目：${dirs.join(' ')}，用 --id 指定`);
    target = dirs[0];
  }
  await withProjectLock(root, target, () => {
    if (loadBundle(root, target) || getProjectMaybe(root, target)) {
      throw new Error(`本机已有项目 ${target}，请用 sync 拉取远端更新，不要重复 adopt`);
    }
  }, { lock });
  const project = { id: target, repo, defaultBranch: branch, admin: null };
  log(`[adopt] 读取 .pm/${target}/manifest.json`);
  const manifest = await fetchRemoteManifest(project, { retries });
  if (!manifest) throw new Error(`远端没有 .pm/${target}/manifest.json`);
  const partCount = manifest.bundle?.parts?.length || 1;
  log(`[adopt] 下载 ${partCount} 个分片（并发 4）`);
  const bundle = await fetchRemoteBundle(project, { manifest, retries });
  if (!bundle) throw new Error(`远端数据包读取失败或分片不完整（.pm/${target}/），网络不稳可重试 adopt`);
  log('[adopt] 重算事实指纹并校验');
  const check = verifyBundle(bundle);
  if (!check.ok) {
    const err = new Error(`远端数据包校验失败：重算 ${check.actual.slice(7, 15)} ≠ 包内 ${String(check.expected).slice(7, 15)}`);
    err.code = 'INVALID_BUNDLE';
    throw err;
  }
  if (bundle.project?.id && bundle.project.id !== target) {
    throw new Error(`数据包 id ${bundle.project.id} 与目标 ${target} 不一致`);
  }
  const admins = adminList({ admin: bundle.project?.admin, members: bundle.project?.members });
  const info = {
    status: dryRun ? 'dry-run' : 'adopted',
    id: target,
    hash: bundle.hashes.facts,
    asOf: bundle.asOf,
    nodes: bundle.plan?.nodes?.length || 0,
    admin: admins.join('、') || null,
  };
  if (dryRun) return info;
  return withProjectLock(root, target, () => {
    createProject(root, {
      id: target,
      name: bundle.project?.name || target,
      repo,
      localRepo: null,
      defaultBranch: bundle.project?.defaultBranch || branch,
      admin: bundle.project?.admin || null,
      members: bundle.project?.members || {},
      plan: bundle.plan,
      planSource: bundle.project?.planSource || '',
    });
    saveBundle(root, bundle);
    try {
      const p = getProject(root, target);
      writeAgentLocal(root, p, bundle, detectIdentity(p));
    } catch {}
    return { ...info, status: 'adopted' };
  }, { lock });
}

function getProjectMaybe(root, id) {
  try {
    return getProject(root, id);
  } catch {
    return null;
  }
}

export function splitBundleParts(b64) {
  const parts = [];
  for (let i = 0; i < b64.length; i += BUNDLE_PART_CHARS) parts.push(b64.slice(i, i + BUNDLE_PART_CHARS));
  return parts;
}

export function isRefConflict(err) {
  return /422|fast.?forward|not a fast|already exists|conflict/i.test(String(err?.message || ''));
}

// 进度数据只保留一份：远端已有比本地更新的数据包时拒绝覆盖，要求先 sync/刷新。
export function publishBaseConflict(remote, bundle) {
  if (!remote?.hash || remote.hash === bundle?.hashes?.facts) return null;
  const remoteAt = Date.parse(remote.asOf || '');
  const localAt = Date.parse(bundle?.asOf || '');
  if (Number.isFinite(remoteAt) && Number.isFinite(localAt) && remoteAt > localAt) {
    return `远端进度（${remote.asOf}）比本地（${bundle.asOf}）新，本次未发布：请先同步或刷新，避免覆盖唯一的进度数据包。`;
  }
  return null;
}

// 远端解读保留规则：本机没生成的文件不做删除，其余陈旧文件照删。
export function planRemotePrune(remoteFiles, localPaths, interpPrefix) {
  const local = new Set(localPaths);
  const scope = typeof interpPrefix === 'string' && interpPrefix.endsWith('/interpretations/')
    ? interpPrefix.slice(0, -'interpretations/'.length) : '';
  const owned = /^\.pm\/[a-z0-9][a-z0-9-]*\/$/.test(scope)
    ? Object.keys(remoteFiles || {}).filter((p) => isScopedPath(p, scope)) : [];
  const inherited = owned.filter((p) => p.startsWith(interpPrefix) && !local.has(p));
  const stale = owned.filter((p) => !local.has(p) && !inherited.includes(p));
  return { inherited, stale };
}

export async function publishBundle(root, project, bundle, { log = console.log } = {}) {
  const identity = detectIdentity(project);
  if (!isAdmin(project, identity)) {
    const err = new Error(adminDenied(project, identity));
    err.code = 'FORBIDDEN';
    throw err;
  }
  const check = validateProjectBundle(project, bundle);
  const branch = project.defaultBranch || 'main';
  const ref = await readBranchSnapshot(project, branch);
  const baseSha = ref?.object?.sha || null;
  const base = isFullSha(baseSha) ? await readCommitSnapshot(project, baseSha) : null;
  const baseTreeSha = base?.tree?.sha || null;
  if (!isFullSha(baseSha) || !isFullSha(baseTreeSha)) {
    const e = new Error(`远端 ${branch} 快照不完整，拒绝发布`);
    e.code = 'CONFLICT';
    throw e;
  }

  const remote = await fetchRemoteManifest(project, { retries: 1, ref: baseSha });
  const staleRemote = publishBaseConflict(remote, bundle);
  if (staleRemote) {
    const err = new Error(staleRemote);
    err.code = 'CONFLICT';
    throw err;
  }

  const agent = buildAgent(project, bundle, null);
  const gz = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 9 });
  const b64 = gz.toString('base64');
  const parts = splitBundleParts(b64);
  const partRels = parts.map((_, i) => `bundle.parts/${String(i).padStart(2, '0')}.b64`);
  const files = new Map();
  parts.forEach((text, i) => files.set(`${pmRoot(project)}/${partRels[i]}`, text));
  files.set(`${pmRoot(project)}/README.md`, agent.readme);
  files.set(`${pmRoot(project)}/AGENT.md`, agent.guide);
  files.set(`${pmRoot(project)}/agent/index.json`, JSON.stringify(agent.index, null, 2));
  files.set(`${pmRoot(project)}/trail.md`, renderTrail(bundle, check));
  for (const f of agent.files) files.set(f.path, f.content);

  const interpDir = join(root, 'data', project.id, 'interpretations');
  if (existsSync(interpDir)) {
    for (const name of readdirSync(interpDir)) {
      if (!name.endsWith('.md')) continue;
      files.set(`${pmRoot(project)}/interpretations/${name}`, readFileSync(join(interpDir, name), 'utf8'));
    }
  }

  // 本机没有的远端解读不做删除，哈希继续记进 manifest，避免新机器 adopt 后写回把解读清掉。
  const interpPrefix = `${pmRoot(project)}/interpretations/`;
  const { inherited } = planRemotePrune(remote?.files, [...files.keys()], interpPrefix);

  const hashes = {};
  for (const [path, content] of files) hashes[path] = fileHash(content);
  for (const p of inherited) hashes[p] = remote.files[p];
  const manifest = {
    generatedBy: 'PM',
    format: 'pm-audit/remote',
    version: 1,
    project: project.id,
    admin: project.admin || null,
    publishedBy: identity.login || null,
    hash: bundle.hashes.facts,
    asOf: bundle.asOf,
    bundle: {
      format: 'gzip-base64-parts',
      parts: partRels,
      sha256: createHash('sha256').update(gz).digest('hex'),
      bytes: gz.length,
    },
    updatedAt: new Date().toISOString(),
    files: hashes,
  };
  const manifestPath = `${pmRoot(project)}/manifest.json`;
  files.set(manifestPath, JSON.stringify(manifest, null, 2));

  const changedFiles = [...files].filter(([path, content]) => path !== manifestPath && remote?.files?.[path] !== fileHash(content));
  const { stale } = planRemotePrune(remote?.files, [...files.keys()], interpPrefix);
  if (!changedFiles.length && !stale.length && remote?.hash === bundle.hashes.facts) {
    return { status: 'same', hash: bundle.hashes.facts, commit: baseSha, parent: baseSha, baseSha, baseTreeSha };
  }
  const changed = [...changedFiles, [manifestPath, files.get(manifestPath)]];

  log(`[pm] 发布 ${project.id}: ${changed.length} 个文件变化，删除 ${stale.length} 个旧文件`);
  const blobs = await mapLimit(changed, 4, async ([path, content]) => {
    const blob = await ghJson(`repos/${project.repo}/git/blobs`, {
      method: 'POST',
      body: { content, encoding: 'utf8' },
    });
    return { path, mode: '100644', type: 'blob', sha: blob.sha };
  });
  const treeEntries = [...blobs, ...stale.map((path) => ({ path, mode: '100644', type: 'blob', sha: null }))];

  const tree = await ghJson(`repos/${project.repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseTreeSha, tree: treeEntries },
  });
  const message = `[PM] ${project.name} 数据包 ${String(bundle.asOf).slice(0, 16).replace('T', ' ')} (${shortHash(bundle.hashes.facts)})`;
  const commit = await ghJson(`repos/${project.repo}/git/commits`, {
    method: 'POST',
    body: { message, tree: tree.sha, parents: [baseSha] },
  });
  try {
    await ghJson(`repos/${project.repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH',
      body: { sha: commit.sha, force: false },
    });
  } catch (err) {
    if (isRefConflict(err)) {
      const e = new Error(
        `写回冲突：远端 ${branch} 在发布期间被更新（可能另一台管理员机器写了回）。本次未提交，请先同步（sync）再重试。`,
      );
      e.code = 'CONFLICT';
      throw e;
    }
    throw err;
  }

  try {
    writeJsonFile(join(root, 'cache', project.id, 'published.json'), {
      hash: bundle.hashes.facts, commit: commit.sha, updatedAt: new Date().toISOString(),
    });
  } catch {}

  return { status: 'published', commit: commit.sha, parent: baseSha, baseSha, baseTreeSha, changed: changed.length + stale.length, hash: bundle.hashes.facts };
}
