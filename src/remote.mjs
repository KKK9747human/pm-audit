import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ghJson } from './gh.mjs';
import { verifyBundle, saveBundle, loadBundle } from './bundle.mjs';
import { buildAgent, writeAgentLocal } from './agent.mjs';
import { renderTrail } from './trail.mjs';
import { detectIdentity, isAdmin, adminDenied, adminList } from './identity.mjs';
import { createProject, getProject } from './project.mjs';
import { fileHash, shortHash } from './brand.mjs';

export function pmRoot(project) {
  return `.pm/${project.id}`;
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

async function contents(project, relPath, { retries = 2 } = {}) {
  const branch = encodeURIComponent(project.defaultBranch || 'main');
  try {
    const j = await ghJson(`repos/${project.repo}/contents/${relPath}?ref=${branch}`, { retries });
    if (!j) return null;
    let b64 = j.content;
    if (!b64 && j.sha) {
      const blob = await ghJson(`repos/${project.repo}/git/blobs/${j.sha}`, { retries });
      b64 = blob?.content;
    }
    if (!b64) return null;
    return {
      text: Buffer.from(b64, 'base64').toString('utf8'),
      sha: j.sha,
    };
  } catch {
    return null;
  }
}

async function contentsB64(project, relPath, { retries = 2 } = {}) {
  const branch = encodeURIComponent(project.defaultBranch || 'main');
  try {
    const j = await ghJson(`repos/${project.repo}/contents/${relPath}?ref=${branch}`, { retries });
    if (!j) return null;
    let raw = j.content;
    if (!raw && j.sha) {
      const blob = await ghJson(`repos/${project.repo}/git/blobs/${j.sha}`, { retries });
      raw = blob?.content;
    }
    if (!raw) return null;
    return Buffer.from(raw, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export async function fetchRemoteManifest(project, opts) {
  const f = await contents(project, `${pmRoot(project)}/manifest.json`, opts);
  if (!f) return null;
  try {
    return JSON.parse(f.text);
  } catch {
    return null;
  }
}

const BUNDLE_PART_CHARS = 48000;

async function lastPmCommit(project, opts) {
  const branch = encodeURIComponent(project.defaultBranch || 'main');
  const path = encodeURIComponent(`${pmRoot(project)}/manifest.json`);
  try {
    const j = await ghJson(`repos/${project.repo}/commits?path=${path}&sha=${branch}&per_page=1`, opts);
    const c = Array.isArray(j) ? j[0] : null;
    if (!c) return null;
    return {
      sha: c.sha,
      author: c.author?.login || null,
      authorName: c.commit?.author?.name || null,
      date: c.commit?.author?.date || null,
    };
  } catch {
    return null;
  }
}

export async function fetchRemoteBundle(project, { manifest, ...opts } = {}) {
  const man = manifest || (await fetchRemoteManifest(project, opts));
  if (man?.bundle?.parts?.length) {
    const parts = man.bundle.parts;
    const chunks = await mapLimit(parts, 4, async (rel) => {
      const b64 = await contentsB64(project, `${pmRoot(project)}/${rel}`, { retries: 3, ...opts });
      return b64 ? b64.replace(/\s/g, '') : null;
    });
    if (chunks.some((c) => !c)) return null;
    const gz = Buffer.from(chunks.join(''), 'base64');
    if (man.bundle.sha256 && createHash('sha256').update(gz).digest('hex') !== man.bundle.sha256) return null;
    try {
      return JSON.parse(gunzipSync(gz).toString('utf8'));
    } catch {
      return null;
    }
  }
  const gzB64 = await contentsB64(project, `${pmRoot(project)}/bundle.pm.json.gz`, { retries: 2, ...opts });
  if (gzB64) {
    try {
      return JSON.parse(gunzipSync(Buffer.from(gzB64.replace(/\s/g, ''), 'base64')).toString('utf8'));
    } catch {
      return null;
    }
  }
  const f = await contents(project, `${pmRoot(project)}/bundle.pm.json`, { retries: 1, ...opts });
  if (!f) return null;
  return JSON.parse(f.text);
}

export async function syncFromRemote(root, project) {
  const manifest = await fetchRemoteManifest(project, { retries: 1 });
  if (!manifest) return { status: 'absent' };
  const local = loadBundle(root, project.id);
  if (manifest.hash && local?.hashes?.facts === manifest.hash) {
    return { status: 'same', hash: manifest.hash, asOf: manifest.asOf };
  }
  const last = await lastPmCommit(project, { retries: 1 });
  const admins = adminList(project);
  if (admins.length && last?.author && !admins.some((a) => a.toLowerCase() === last.author.toLowerCase())) {
    return {
      status: 'untrusted',
      expectedAdmin: admins.join('、'),
      author: last.author,
      authorName: last.authorName,
      commit: last.sha,
    };
  }
  const bundle = await fetchRemoteBundle(project, { manifest, retries: 1 });
  if (!bundle) return { status: 'absent' };
  let check;
  try {
    check = verifyBundle(bundle);
  } catch (err) {
    return { status: 'invalid', error: err.message };
  }
  if (!check.ok) {
    return { status: 'invalid', expected: check.expected, actual: check.actual };
  }
  saveBundle(root, bundle);
  try {
    writeAgentLocal(root, project, bundle, detectIdentity(project));
  } catch {}
  return {
    status: 'updated',
    hash: bundle.hashes.facts,
    asOf: bundle.asOf,
    remoteCommit: manifest.commit || null,
  };
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
export async function adoptFromRemote(root, { repo, id, branch = 'main', dryRun = false, retries = 3, log = () => {} } = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) throw new Error('仓库地址必须是 owner/name 形式');
  let target = id || null;
  if (!target) {
    const dirs = (await listRemoteDirs(repo, branch, '.pm', retries)).filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n));
    if (!dirs.length) throw new Error(`远端 ${repo} 的 .pm/ 下没有可用项目`);
    if (dirs.length > 1) throw new Error(`远端有多个项目：${dirs.join(' ')}，用 --id 指定`);
    target = dirs[0];
  }
  if (loadBundle(root, target) || getProjectMaybe(root, target)) {
    throw new Error(`本机已有项目 ${target}，请用 sync 拉取远端更新，不要重复 adopt`);
  }
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
  const inherited = Object.keys(remoteFiles || {}).filter((p) => p.startsWith(interpPrefix) && !local.has(p));
  const stale = Object.keys(remoteFiles || {}).filter((p) => !local.has(p) && !inherited.includes(p));
  return { inherited, stale };
}

export async function publishBundle(root, project, bundle, { log = console.log } = {}) {
  const identity = detectIdentity(project);
  if (!isAdmin(project, identity)) {
    const err = new Error(adminDenied(project, identity));
    err.code = 'FORBIDDEN';
    throw err;
  }
  const remote = await fetchRemoteManifest(project, { retries: 1 });
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
  files.set(`${pmRoot(project)}/trail.md`, renderTrail(bundle, verifyBundle(bundle)));
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
    return { status: 'same', hash: bundle.hashes.facts };
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

  const branch = project.defaultBranch || 'main';
  const ref = await ghJson(`repos/${project.repo}/git/ref/heads/${branch}`);
  const base = await ghJson(`repos/${project.repo}/git/commits/${ref.object.sha}`);
  const tree = await ghJson(`repos/${project.repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: base.tree.sha, tree: treeEntries },
  });
  const message = `[PM] ${project.name} 数据包 ${String(bundle.asOf).slice(0, 16).replace('T', ' ')} (${shortHash(bundle.hashes.facts)})`;
  const commit = await ghJson(`repos/${project.repo}/git/commits`, {
    method: 'POST',
    body: { message, tree: tree.sha, parents: [ref.object.sha] },
  });
  try {
    await ghJson(`repos/${project.repo}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: { sha: commit.sha },
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
    const stateDir = join(root, 'cache', project.id);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'published.json'),
      JSON.stringify({ hash: bundle.hashes.facts, commit: commit.sha, updatedAt: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch {}

  return { status: 'published', commit: commit.sha, changed: changed.length + stale.length, hash: bundle.hashes.facts };
}
