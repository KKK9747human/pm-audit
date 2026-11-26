import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { complete } from './llm.mjs';
import { loadBundle } from './bundle.mjs';
import { pmStamp, pmFooter } from './brand.mjs';
import { postWatchComment } from './comment.mjs';
import { ghJson } from './gh.mjs';
import { writeAtomicFile } from './project-lock.mjs';

const MAX_PROBE_COMMITS = 1000;
const MAX_PROBE_ITEMS = 1000;
const GRAPHQL_PAGE_SIZE = 50;
const PROBE_BUDGET = 120000;
const PROBE_LARGE_TIMEOUT = 10000;
const PROBE_LARGE_ATTEMPTS = 1;
const PROBE_SMALL_TIMEOUT = 30000;
const PROBE_SMALL_ATTEMPTS = 2;
const isFullSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v);
const ownMessage = (message) => /^\[PM\]\s/.test(message || '');
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isNullableTime = (value) => value === null || isNonEmptyString(value);
const auditItemComplete = (item) => Number.isInteger(item?.number) && item.number > 0
  && typeof item.title === 'string' && (item.body === null || typeof item.body === 'string')
  && (item.state === 'open' || item.state === 'closed') && isNonEmptyString(item.updated_at)
  && isNullableTime(item.closed_at);
const auditItemFields = (item) => [
  item?.number, item?.state, item?.title, item?.body, item?.updated_at, item?.closed_at,
];

const ITEM_QUERIES = {
  pulls: `query ProbePulls($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      entries: pullRequests(first: ${GRAPHQL_PAGE_SIZE}, after: $after, states: [OPEN, CLOSED, MERGED], orderBy: {field: CREATED_AT, direction: ASC}) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          number title body state updated_at: updatedAt closed_at: closedAt
          merged_at: mergedAt mergeCommit { oid } headRefOid headRefName baseRefOid baseRefName
        }
      }
    }
  }`,
  issues: `query ProbeIssues($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      entries: issues(first: ${GRAPHQL_PAGE_SIZE}, after: $after, states: [OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: ASC}) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { number title body state updated_at: updatedAt closed_at: closedAt }
      }
    }
  }`,
};

async function auditItems(call, repo, kind) {
  const [owner, name] = repo.split('/');
  const items = [];
  const numbers = new Set();
  const cursors = new Set();
  const incomplete = () => ({ items, complete: false });
  let after = null;
  let total = null;
  for (let page = 0; page < MAX_PROBE_ITEMS / GRAPHQL_PAGE_SIZE; page++) {
    const result = await call('graphql', { body: { query: ITEM_QUERIES[kind], variables: { owner, name, after } } });
    const repository = result?.data?.repository;
    const entries = repository?.entries;
    const info = entries?.pageInfo;
    if ((result?.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length))
      || typeof repository?.nameWithOwner !== 'string' || repository.nameWithOwner.toLowerCase() !== repo.toLowerCase()
      || !Number.isInteger(entries?.totalCount) || entries.totalCount < 0 || entries.totalCount > MAX_PROBE_ITEMS
      || (total !== null && total !== entries.totalCount)
      || !Array.isArray(entries?.nodes) || entries.nodes.length > GRAPHQL_PAGE_SIZE
      || typeof info?.hasNextPage !== 'boolean'
      || !(info.endCursor === null || isNonEmptyString(info.endCursor))) return incomplete();
    total = entries.totalCount;
    for (const node of entries.nodes) {
      if (!Number.isInteger(node?.number) || node.number <= 0 || numbers.has(node.number)
        || (kind === 'pulls' && node.mergeCommit !== null && !isFullSha(node.mergeCommit?.oid))) return incomplete();
      numbers.add(node.number);
      items.push({
        ...node,
        body: node.body === '' ? null : node.body,
        state: node.state === 'OPEN' ? 'open' : node.state === 'CLOSED' || (kind === 'pulls' && node.state === 'MERGED') ? 'closed' : undefined,
        ...(kind === 'pulls' ? {
          merge_commit_sha: node.mergeCommit === null ? null : node.mergeCommit?.oid,
          head: { sha: node.headRefOid, ref: node.headRefName },
          base: { sha: node.baseRefOid, ref: node.baseRefName },
        } : {}),
      });
    }
    if (!info.hasNextPage) return { items, complete: items.length === total };
    if (!entries.nodes.length || items.length >= total || !isNonEmptyString(info.endCursor)
      || cursors.has(info.endCursor)) return incomplete();
    cursors.add(info.endCursor);
    after = info.endCursor;
  }
  return incomplete();
}

// GitHub tree 条目：普通文件 100644/100755，目录 040000（有时写作 40000），
// 子模块 gitlink 160000。mode 必须与类型匹配，否则视为证据无效。
const TREE_MODES = Object.freeze({
  blob: ['100644', '100755'],
  tree: ['040000', '40000'],
  commit: ['160000'],
});

async function treeEntries(get, sha) {
  const tree = await get(`git/trees/${sha}`);
  if (!isFullSha(tree?.sha) || tree.sha !== sha || !Array.isArray(tree.tree)) throw new Error('树证据不完整');
  if (tree.truncated === true) throw new Error('树证据被截断，不能当作完整范围证明');
  const entries = new Map();
  for (const entry of tree.tree) {
    if (!isNonEmptyString(entry?.path) || entry.path.includes('/') || entry.path.includes('\\')
      || entry.path === '.' || entry.path === '..'
      || !isFullSha(entry?.sha) || !Array.isArray(TREE_MODES[entry.type])
      || !TREE_MODES[entry.type].includes(String(entry.mode))) {
      throw new Error('树条目无效');
    }
    if (entries.has(entry.path)) throw new Error('树条目重复');
    entries.set(entry.path, entry);
  }
  return entries;
}

async function changedTreeEntries(get, oldSha, newSha) {
  if (oldSha === newSha) return new Map();
  const [before, after] = await Promise.all([
    oldSha ? treeEntries(get, oldSha) : new Map(),
    newSha ? treeEntries(get, newSha) : new Map(),
  ]);
  const changed = new Map();
  const same = (a, b) => a.sha === b.sha && a.type === b.type && String(a.mode) === String(b.mode);
  for (const [name, entry] of after) {
    const prev = before.get(name);
    if (!prev || !same(prev, entry)) changed.set(name, { prev, next: entry });
  }
  for (const [name, entry] of before) if (!after.has(name)) changed.set(name, { prev: entry, next: null });
  return changed;
}

async function scopeWithinProject(get, parentTree, commitTree, projectId) {
  const root = await changedTreeEntries(get, parentTree, commitTree);
  if (!root.size) return false;
  for (const name of root.keys()) if (name !== '.pm') return false;
  const pm = root.get('.pm');
  const oldPm = pm.prev?.type === 'tree' ? pm.prev.sha : null;
  const newPm = pm.next?.type === 'tree' ? pm.next.sha : null;
  if ((pm.prev && !oldPm) || (pm.next && !newPm)) return false;
  if (oldPm === newPm) return true;
  const changed = await changedTreeEntries(get, oldPm, newPm);
  for (const [name, pair] of changed) {
    if (name !== projectId) return false;
    if ((pair.prev && pair.prev.type !== 'tree') || (pair.next && pair.next.type !== 'tree')) return false;
  }
  return true;
}

async function proveTreeScope(get, projectId, commit) {
  const own = await get(`git/commits/${commit.sha}`);
  if (own?.sha !== commit.sha || !Array.isArray(own.parents) || own.parents.length !== 1
    || own.parents[0]?.sha !== commit.parents[0] || !isFullSha(own.tree?.sha)) {
    throw new Error('提交树证据与探针不一致');
  }
  const parent = await get(`git/commits/${commit.parents[0]}`);
  if (parent?.sha !== commit.parents[0] || !isFullSha(parent.tree?.sha)) throw new Error('父提交树证据不一致');
  return scopeWithinProject(get, parent.tree.sha, own.tree.sha, projectId);
}

async function compareChain(get, baseSha, headSha, probe) {
  let total = null;
  const chain = [];
  for (let page = 1; page <= MAX_PROBE_COMMITS / 100; page++) {
    const cmp = await get(`compare/${baseSha}...${headSha}?per_page=100&page=${page}`, { large: true });
    if (!Array.isArray(cmp?.commits) || !Number.isInteger(cmp.total_commits)) throw new Error('对比响应格式错误');
    if (cmp.status === 'diverged' || cmp.status === 'behind') {
      probe.historyChanged = true;
      return [];
    }
    if (cmp.status !== 'ahead' || cmp.merge_base_commit?.sha !== baseSha
      || (total !== null && total !== cmp.total_commits)) throw new Error('对比证据不一致');
    total = cmp.total_commits;
    chain.push(...cmp.commits.map((c) => ({
      sha: c.sha, message: c.commit?.message || '', parents: (c.parents || []).map((p) => p.sha),
    })));
    if (chain.length === total) return chain;
    if (cmp.commits.length < 100 || chain.length > total) throw new Error('对比分页不完整');
  }
  throw new Error('对比分页不完整');
}

async function commitListChain(get, baseSha, headSha) {
  const bySha = new Map();
  const chain = [];
  const visited = new Set();
  let cursor = headSha;
  let exhausted = false;
  for (let page = 1; page <= MAX_PROBE_COMMITS / 100; page++) {
    const data = await get(`commits?sha=${headSha}&per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new Error('提交列表响应格式错误');
    for (const item of data) {
      const parents = item?.parents?.map((p) => p?.sha);
      if (!isFullSha(item?.sha) || typeof item?.commit?.message !== 'string' || !Array.isArray(parents)
        || !parents.every(isFullSha) || !isFullSha(item?.commit?.tree?.sha)) throw new Error('提交元数据不完整');
      bySha.set(item.sha, { sha: item.sha, message: item.commit.message, parents, tree: item.commit.tree.sha });
    }
    if (data.length < 100) exhausted = true;
    // 已经拿到的页面就足够往回走：一旦走到旧基准就停，不再读更早的历史。
    while (cursor !== baseSha) {
      if (visited.has(cursor)) throw new Error('提交链重复');
      const commit = bySha.get(cursor);
      if (!commit) break;
      visited.add(cursor);
      chain.push(commit);
      if (chain.length > MAX_PROBE_COMMITS) return { incomplete: true };
      if (!commit.parents.length) return { historyChanged: true };
      cursor = commit.parents[0];
    }
    if (cursor === baseSha) return { chain };
    if (exhausted) return { historyChanged: true };
  }
  return { incomplete: true };
}

const defaultSleep = (ms, { signal } = {}) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

export async function probeRemote(project, {
  prevProbe = null, knownOwn = new Set(), request = ghJson,
  now = Date.now, sleep = defaultSleep,
} = {}) {
  const branch = project.defaultBranch || 'main';
  const deadline = now() + PROBE_BUDGET;
  const remaining = () => deadline - now();
  const budgetError = () => Object.assign(new Error('探针时间预算已用完'), { code: 'PROBE_BUDGET' });
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(budgetError()), PROBE_BUDGET);
  const checkBudget = () => {
    if (remaining() <= 0 && !signal.aborted) controller.abort(budgetError());
    signal.throwIfAborted();
  };
  const cache = new Map();
  const active = new Set();
  let stage = '仓库元数据';
  const call = async (url, { large = false, body } = {}) => {
    checkBudget();
    const key = JSON.stringify([url, body]);
    const run = async () => {
      const attempts = large ? PROBE_LARGE_ATTEMPTS : PROBE_SMALL_ATTEMPTS;
      const cap = large ? PROBE_LARGE_TIMEOUT : PROBE_SMALL_TIMEOUT;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        checkBudget();
        try {
          const result = await request(url, {
            retries: 1, timeout: Math.min(remaining(), cap), signal,
            ...(body === undefined ? {} : { method: 'POST', body }),
          });
          checkBudget();
          return result;
        } catch (err) {
          checkBudget();
          if (err?.code === 'PROBE_BUDGET' || attempt === attempts) throw err;
          await sleep(Math.min(2000 * attempt, remaining()), { signal });
        }
      }
    };
    if (cache.has(key)) return cache.get(key);
    const pending = run();
    cache.set(key, pending);
    active.add(pending);
    pending.then(() => active.delete(pending), () => {
      active.delete(pending);
      cache.delete(key);
    });
    return pending;
  };
  const get = (url, options) => call(`repos/${project.repo}/${url}`, options);
  const list = async (url, perPage) => {
    const items = [];
    for (let page = 1; page <= MAX_PROBE_ITEMS / perPage; page++) {
      const data = await get(`${url}${url.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`);
      if (!Array.isArray(data) || data.length > perPage) throw new Error('探针列表响应格式错误');
      items.push(...data);
      if (data.length < perPage) return { items, complete: true };
    }
    return { items, complete: false };
  };
  const probe = {
    pushedAt: null, defaultBranch: branch, repositoryDefaultBranch: null, headSha: null,
    branches: [], openPrs: [], openIssues: [],
    snapshotComplete: false, recentCommits: [], commitsComplete: false,
    compareBase: prevProbe?.headSha || null, compareHead: null,
    budgetExhausted: false, timeoutStage: null,
  };
  try {
    stage = '仓库元数据';
    const meta = await call(`repos/${project.repo}`);
    stage = '分支/PR/issue 列表';
    const [branches, pulls, issues] = await Promise.all([
      list('branches', 100), auditItems(call, project.repo, 'pulls'), auditItems(call, project.repo, 'issues'),
    ]);
    const headSha = branches.items.find((b) => b?.name === branch)?.commit?.sha || null;
    probe.pushedAt = meta?.pushed_at || null;
    probe.repositoryDefaultBranch = meta?.default_branch || null;
    probe.headSha = headSha;
    probe.branches = branches.items.map((b) => ({ name: b?.name, sha: b?.commit?.sha || null }));
    probe.openPrs = pulls.items.map((p) => JSON.stringify([
      ...auditItemFields(p), p?.merged_at, p?.state === 'closed' ? p?.merge_commit_sha : null,
      p?.head?.sha, p?.head?.ref, p?.base?.ref,
    ]));
    probe.openIssues = issues.items.map((i) => JSON.stringify(auditItemFields(i)));
    probe.compareHead = headSha;
    probe.snapshotComplete = branches.complete && pulls.complete && issues.complete && isFullSha(headSha)
      && isNonEmptyString(meta?.pushed_at) && isNonEmptyString(meta?.default_branch)
      && branches.items.every((b) => isNonEmptyString(b?.name) && isFullSha(b?.commit?.sha))
      && pulls.items.every((p) => auditItemComplete(p) && isNullableTime(p.merged_at)
        && (p.merge_commit_sha === null || isFullSha(p.merge_commit_sha))
        && isFullSha(p.head?.sha) && isNonEmptyString(p.head?.ref)
        && isFullSha(p.base?.sha) && isNonEmptyString(p.base?.ref))
      && issues.items.every(auditItemComplete);
    checkBudget();
    if (!probe.snapshotComplete || !isFullSha(prevProbe?.headSha) || prevProbe.headSha === headSha) return probe;
    stage = '提交增量对比';
    try {
      let chain = null;
      try {
        chain = await compareChain(get, prevProbe.headSha, headSha, probe);
      } catch (err) {
        if (err?.code === 'PROBE_BUDGET') throw err;
        const fallback = await commitListChain(get, prevProbe.headSha, headSha);
        if (fallback.historyChanged) probe.historyChanged = true;
        else if (fallback.chain) chain = fallback.chain;
      }
      checkBudget();
      if (probe.historyChanged) return probe;
      if (!Array.isArray(chain) || !chain.length) return probe;
      probe.recentCommits = chain;
      probe.commitsComplete = new Set(chain.map((c) => c.sha)).size === chain.length
        && chain.every((c) => isFullSha(c.sha))
        && chain.some((c) => c.sha === headSha);
      checkBudget();
      if (!probe.commitsComplete) return probe;
      stage = '自身写回范围证明';
      for (const commit of probe.recentCommits) {
        if (!knownOwn.has(commit.sha) || !ownMessage(commit.message)) continue;
        if (!Array.isArray(commit.parents) || commit.parents.length !== 1) continue;
        commit.files = [];
        commit.filesComplete = false;
        try {
          for (let page = 1; page <= 30; page++) {
            const detail = await get(`commits/${commit.sha}?per_page=100&page=${page}`, { large: true });
            if (detail?.sha !== commit.sha || !Array.isArray(detail.files)
              || JSON.stringify((detail.parents || []).map((p) => p.sha)) !== JSON.stringify(commit.parents)) break;
            commit.files.push(...detail.files.flatMap((f) => f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
            if (detail.files.length < 100) {
              commit.filesComplete = true;
              break;
            }
          }
        } catch (err) {
          if (err?.code === 'PROBE_BUDGET') throw err;
          commit.filesComplete = false;
        }
        if (!commit.filesComplete) commit.scopeVerified = await proveTreeScope(get, project.id, commit);
      }
    } catch (err) {
      if (err?.code === 'PROBE_BUDGET') throw err;
      probe.commitsComplete = false;
    }
    checkBudget();
    return probe;
  } catch (err) {
    if (err?.code === 'PROBE_BUDGET') {
      probe.budgetExhausted = true;
      probe.timeoutStage = stage;
      probe.snapshotComplete = false;
      probe.commitsComplete = false;
      return probe;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await Promise.allSettled([...active]);
  }
}

const otherEvidence = (probe) => JSON.stringify([
  probe.defaultBranch, probe.repositoryDefaultBranch,
  [...(probe.openPrs || [])].sort(), [...(probe.openIssues || [])].sort(),
  (probe.branches || []).filter((b) => b.name !== probe.defaultBranch)
    .map((b) => `${b.name}:${b.sha}`).sort(),
]);

export function signatureOf(probe) {
  return probe ? JSON.stringify([probe.pushedAt || '', probe.headSha || '', otherEvidence(probe)]) : null;
}

export function classifyProbe({ prevProbe, nextProbe, knownOwn = new Set(), projectId }) {
  const changed = { changed: true, ownOnly: false, unknown: false, reason: '远端有真实变化' };
  const unknown = { changed: false, ownOnly: false, unknown: true, reason: '探针证据不完整，等待重试' };
  if (!nextProbe?.snapshotComplete) {
    return nextProbe?.budgetExhausted
      ? { changed: false, ownOnly: false, unknown: true, reason: `探针时间预算耗尽（${nextProbe.timeoutStage || '未知阶段'}），等待重试` }
      : unknown;
  }
  if (!prevProbe?.snapshotComplete) return changed;
  if (signatureOf(prevProbe) === signatureOf(nextProbe)) {
    return { changed: false, ownOnly: false, unknown: false, reason: '无变化' };
  }
  if (otherEvidence(prevProbe) !== otherEvidence(nextProbe) || nextProbe.headSha === prevProbe.headSha || nextProbe.historyChanged) return changed;
  if (nextProbe.compareBase !== prevProbe.headSha || nextProbe.compareHead !== nextProbe.headSha) return unknown;
  const own = onlyOwnSince(nextProbe.recentCommits, prevProbe.headSha, knownOwn, {
    complete: nextProbe.commitsComplete, headSha: nextProbe.headSha, projectId,
  });
  if (own.unknown) return unknown;
  return own.ownOnly
    ? { changed: false, ownOnly: true, unknown: false, commits: own.commits, reason: '仅 PM 自身写回' }
    : changed;
}

export function ownCommit(commit, knownOwn = new Set(), projectId) {
  const prefix = `.pm/${projectId}/`;
  const safePath = (p) => typeof p === 'string' && p.startsWith(prefix)
    && !p.includes('\\') && !p.split('/').some((part) => !part || part === '.' || part === '..');
  const scopeOk = commit?.scopeVerified === true
    || (commit?.filesComplete === true && Array.isArray(commit.files)
      && commit.files.length > 0 && commit.files.every(safePath));
  if (!projectId || !commit || !isFullSha(commit.sha) || !knownOwn.has(commit.sha) || !ownMessage(commit.message)
    || !Array.isArray(commit.parents) || commit.parents.length !== 1 || !isFullSha(commit.parents[0])
    || !scopeOk) {
    return { own: false, sha: commit?.sha || null };
  }
  return { own: true, sha: commit.sha, parent: commit.parents[0], message: commit.message };
}

export function onlyOwnSince(commits, baseSha, knownOwn = new Set(), {
  maxCommits = MAX_PROBE_COMMITS, complete = false, headSha, projectId,
} = {}) {
  const list = Array.isArray(commits) ? commits : [];
  const unknown = { ownOnly: false, unknown: true, commits: [] };
  const real = { ownOnly: false, unknown: false, commits: [] };
  if (!isFullSha(baseSha) || !isFullSha(headSha) || !complete || !list.length || list.length > maxCommits) return unknown;
  const bySha = new Map(list.map((c) => [c.sha, c]));
  if (bySha.size !== list.length) return unknown;
  const own = [];
  const visited = new Set();
  let cursor = headSha;
  while (cursor !== baseSha) {
    if (visited.has(cursor) || !bySha.has(cursor)) return unknown;
    visited.add(cursor);
    const commit = bySha.get(cursor);
    if (knownOwn.has(cursor) && ownMessage(commit.message)
      && commit.scopeVerified === undefined && !commit.filesComplete) return unknown;
    const meta = ownCommit(commit, knownOwn, projectId);
    if (!meta.own) return real;
    own.push({ sha: meta.sha, parent: meta.parent, message: meta.message });
    cursor = meta.parent;
  }
  return visited.size === list.length ? { ownOnly: true, unknown: false, commits: own.reverse() } : real;
}

// 纯决策：这一 tick 要不要全量重算审计。
// real=true 表示远端真有变化（值得写回）；兜底全量 real=false（只本机刷新，不写回，避免指纹随时间漂移刷屏）。
export function decideRefresh({ prevSignature, nextSignature, fresh, tickCount, fullEvery }) {
  if (fresh) return { refresh: true, real: true, reason: '--fresh 强制' };
  if (prevSignature == null) return { refresh: true, real: true, reason: '首次运行' };
  if (nextSignature !== prevSignature) return { refresh: true, real: true, reason: '远端有变化' };
  if (fullEvery > 0 && tickCount > 0 && tickCount % fullEvery === 0) {
    return { refresh: true, real: false, reason: `定时全量兜底(第${tickCount}轮)` };
  }
  return { refresh: false, real: false, reason: '无变化' };
}

// 把探针决策翻译成「这次刷新要不要跳过 / 要不要写回」。
// auto=true（定时轮次）：远端无变化直接跳过，不跑昂贵审计、更不写回。
// auto=false（用户手动刷新）：不跳过，照常本地重算，但同样只有远端真变化才写回，
// 杜绝「指纹随时间漂移 → 每轮都无谓写回」。
export function planRefresh({ auto, decision }) {
  return {
    skip: Boolean(auto && decision && !decision.refresh),
    publish: Boolean(decision && decision.real),
  };
}

// 连续失败退避：interval × min(2^failures, maxFactor)，封顶避免无限拉长。
export function backoffDelay(interval, failures, maxFactor = 6) {
  const f = Math.max(0, Math.min(Number(failures) || 0, 16));
  return interval * Math.min(2 ** f, maxFactor);
}

const tagOf = (text) => {
  const m = /\[([A-C]\d+)\]/.exec(text || '');
  return m ? m[1] : null;
};

function localStat(localRepo, sha) {
  if (!localRepo) return null;
  try {
    return execFileSync('git', ['-C', localRepo, 'show', '--stat', '--format=%s', sha], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export async function watchOnce(project, root, { comment = true, log = console.log } = {}) {
  const cacheDir = join(root, 'cache', project.id);
  const raw = JSON.parse(readFileSync(join(cacheDir, 'raw.json'), 'utf8'));
  const seenPath = join(cacheDir, 'seen.json');
  const seen = existsSync(seenPath) ? JSON.parse(readFileSync(seenPath, 'utf8')) : null;

  const all = raw.branchCommits.flatMap((b) => b.commits.map((c) => ({ ...c, branch: b.name })));
  const shas = [...new Set(all.map((c) => c.sha))].sort();
  if (!seen) {
    writeAtomicFile(seenPath, JSON.stringify({ initializedAt: new Date().toISOString(), shas }, null, 2));
    log(`[watch] ${project.id} 首次运行，登记 ${shas.length} 个已有提交，不解读`);
    return { written: [], comments: [] };
  }

  const seenSet = new Set(seen.shas);
  const fresh = all.filter((c) => !seenSet.has(c.sha) && c.parents < 2 && !/^\[PM\]/.test(c.message || ''));
  if (!fresh.length) {
    log(`[watch] ${project.id} 无新提交`);
    return { written: [], comments: [] };
  }

  const bundle = loadBundle(root, project.id);
  const facts = bundle?.facts;
  const groups = new Map();
  for (const c of fresh) {
    const arr = groups.get(c.branch) || [];
    arr.push(c);
    groups.set(c.branch, arr);
  }

  const outDir = join(root, 'data', project.id, 'interpretations');
  mkdirSync(outDir, { recursive: true });
  const written = [];
  const comments = [];

  for (const [branch, commits] of [...groups.entries()].slice(0, 3)) {
    commits.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const nodeId = branch.startsWith('task/') ? branch.slice(5) : tagOf(commits[0]?.message);
    const node = nodeId ? project.plan.nodes.find((n) => n.id === nodeId) : null;
    const nodeFacts = nodeId && facts ? facts.nodes.find((n) => n.id === nodeId) : null;

    const stats = commits
      .slice(0, 4)
      .map((c, i) => {
        const stat = localStat(project.localRepo, c.sha);
        return `${i + 1}. ${c.sha} ${c.message}${stat ? `\n${stat.split('\n').slice(1, 8).join('\n')}` : ''}`;
      })
      .join('\n\n');

    const context = [
      node
        ? `任务节点 ${node.id}：${node.title}\n验收标准：${node.acceptance || '—'}\n依赖：${(node.deps || []).join(',') || '无'}\n当前状态：${nodeFacts?.state || '未知'}，空闲 ${nodeFacts?.daysIdle ?? '—'} 天`
        : '这组提交没有关联任务节点（分支名不是 task/<节点号>，提交也没有 [节点号] 标记）。',
    ].join('\n');

    const prompt = [
      '你是团队的代码审计助手。下面是某个分支刚推送的一批提交。',
      context,
      '',
      '提交与改动：',
      stats,
      '',
      '只根据上面的内容输出三段，中文，每段最多两句：',
      '1. 这版做了什么（不要猜没出现在改动里的东西）',
      '2. 与任务验收标准偏离的地方（没有就写"无"）',
      '3. 下一步一句（具体到文件或命令）',
    ].join('\n');

    let answer = '';
    try {
      answer = await complete(root, [
        { role: 'system', content: '你是严格的代码审计助手，宁少不多，不编造。' },
        { role: 'user', content: prompt },
      ]);
    } catch (err) {
      answer = `（模型调用失败：${String(err.message).slice(0, 160)}）`;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const file = join(outDir, `${stamp}-${branch.replace(/[\\/:*?"<>|]/g, '_')}-${commits[0].sha.slice(0, 7)}.md`);
    const body = [
      `# [PM] ${branch} @ ${commits[0].sha.slice(0, 7)}`,
      '',
      pmStamp({ kind: '提交解读', project, asOf: bundle?.asOf, hash: bundle?.hashes?.facts }),
      '',
      `- 节点：${nodeId || '未关联'}`,
      `- 提交：${commits.map((c) => `${c.sha} ${c.message}`).join('；')}`,
      `- 生成：${new Date().toISOString()}`,
      '',
      answer || '（空）',
      pmFooter(),
    ].join('\n');
    writeAtomicFile(file, body);
    written.push(file);
    log(`[watch] ${project.id} ${branch}: 写出 ${file}`);
    if (comment) {
      try {
        const r = await postWatchComment(project, { branch, sha: commits[0].sha, body });
        comments.push({ branch, ...r });
        if (r.status === 'posted' || r.status === 'updated') log(`[watch] ${project.id} ${branch}: 已评论 PR #${r.pr}`);
        else log(`[watch] ${project.id} ${branch}: 没有 open PR，跳过评论`);
      } catch (err) {
        log(`[watch] ${project.id} ${branch}: 评论失败 ${String(err.message).slice(0, 120)}`);
      }
    }
  }

  const merged = [...new Set([...seen.shas, ...shas])].sort();
  writeAtomicFile(seenPath, JSON.stringify({ updatedAt: new Date().toISOString(), shas: merged }, null, 2));
  return { written, comments };
}
