import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ghApi, ghJson } from './gh.mjs';
import { summarizeChecks } from './ci.mjs';
import { assertProjectLock, writeJsonFile } from './project-lock.mjs';

const DAY = 86400000;

function gitOut(localRepo, args) {
  return execFileSync('git', ['-C', localRepo, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function localRefSha(localRepo, branch) {
  for (const ref of [`refs/remotes/private/${branch}`, `refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    try {
      return { sha: gitOut(localRepo, ['rev-parse', ref]), ref };
    } catch {}
  }
  return null;
}

function gitLog(localRepo, ref, since) {
  const fmt = '%H%x09%an%x09%aI%x09%P%x09%s';
  const out = gitOut(localRepo, ['log', ref, `--since=${since}`, '-n', '30', `--pretty=${fmt}`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date, parents, ...rest] = line.split('\t');
      return {
        sha: sha.slice(0, 8),
        message: rest.join('\t'),
        date,
        author,
        parents: parents ? parents.split(' ').filter(Boolean).length : 0,
      };
    });
}

export async function ingest(cfg, root, log = console.log, lock) {
  assertProjectLock(root, cfg.id, lock);
  const repo = cfg.repo;
  const since = new Date(Date.now() - cfg.commitWindowDays * DAY).toISOString();

  log(`[ingest] ${repo} 窗口 ${cfg.commitWindowDays} 天`);
  const meta = await ghApi(`repos/${repo}`);
  const issues = await ghApi(`repos/${repo}/issues?state=all`, { pages: 3 });
  const pulls = await ghApi(`repos/${repo}/pulls?state=all`, { pages: 3 });
  const branches = await ghApi(`repos/${repo}/branches`, { pages: 1 });
  log(`[ingest] issues ${issues.length} / pulls ${pulls.length} / branches ${branches.length}`);

  const scan = branches.slice(0, cfg.maxBranchesToScan);
  const branchCommits = [];
  for (const b of scan) {
    const local = cfg.localRepo ? localRefSha(cfg.localRepo, b.name) : null;
    const sameAsRemote = local && local.sha === b.commit.sha;
    let commits = null;
    let source = null;
    if (sameAsRemote) {
      try {
        commits = gitLog(cfg.localRepo, local.ref, since);
        source = 'git-local';
      } catch {}
    }
    if (!commits) {
      try {
        const apiCommits = await ghApi(
          `repos/${repo}/commits?sha=${encodeURIComponent(b.name)}&since=${since}`,
          { pages: 1, perPage: 30, retries: 2 },
        );
        commits = apiCommits.map((c) => ({
          sha: c.sha.slice(0, 8),
          message: (c.commit.message || '').split('\n')[0],
          date: c.commit.author?.date || c.commit.committer?.date,
          author: c.commit.author?.name || c.author?.login || 'unknown',
          parents: c.parents?.length ?? 0,
        }));
        source = 'github-api';
      } catch (err) {
        if (local) {
          try {
            commits = gitLog(cfg.localRepo, local.ref, since);
            source = 'git-local-stale';
          } catch {}
        }
        if (!commits) {
          log(`[ingest] branch ${b.name} 读取失败: ${String(err.message).slice(0, 120)}`);
          continue;
        }
      }
    }
    branchCommits.push({ name: b.name, sha: b.commit.sha, source, commits });
    log(`[ingest] branch ${b.name}: ${commits.length} commits (${source}${local && !sameAsRemote ? ', 本地与远程不同步' : ''})`);
  }

  const pullDetails = {};
  const interesting = pulls.filter(
    (p) => p.state === 'open' || new Date(p.updated_at).getTime() > Date.now() - cfg.commitWindowDays * DAY,
  );
  for (const p of interesting.slice(0, 10)) {
    const d = { files: [], reviews: [], checks: null };
    try {
      d.files = await ghApi(`repos/${repo}/pulls/${p.number}/files`, { pages: 1 });
    } catch {}
    try {
      d.reviews = await ghApi(`repos/${repo}/pulls/${p.number}/reviews`, { pages: 1 });
    } catch {}
    const headSha = p.head?.sha;
    d.checks = summarizeChecks({ headSha });
    if (typeof headSha === 'string' && /^[0-9a-f]{40}$/i.test(headSha)) {
      const perPage = 50;
      const maxPages = 3;
      const list = [];
      const ids = new Set();
      let total = null;
      let complete = false;
      let truncated = false;
      let collectionReason = null;
      for (let page = 1; page <= maxPages; page++) {
        let response;
        try {
          // ghApi appends its own page/per_page and does not paginate object envelopes.
          response = await ghJson(`repos/${repo}/commits/${headSha}/check-runs?per_page=${perPage}&page=${page}`);
        } catch {
          collectionReason = `CI 第 ${page} 页请求失败`;
          break;
        }
        if (!response || typeof response !== 'object' || Array.isArray(response) || !Array.isArray(response.check_runs)) {
          collectionReason = `CI 第 ${page} 页响应格式异常（缺少 check_runs 数组）`;
          break;
        }
        const pageRuns = response.check_runs;
        list.push(...pageRuns);
        if (!Number.isSafeInteger(response.total_count) || response.total_count < 0) {
          collectionReason = `CI 第 ${page} 页缺少有效 total_count`;
          break;
        }
        if (total !== null && response.total_count !== total) {
          collectionReason = `CI 第 ${page} 页 total_count 在分页期间变化`;
          break;
        }
        total = response.total_count;
        if (pageRuns.length > perPage || list.length > total) {
          collectionReason = `CI 第 ${page} 页返回数量超过 per_page 或 total_count`;
          break;
        }
        for (const run of pageRuns) {
          if (!run || typeof run !== 'object' || Array.isArray(run) || !Number.isSafeInteger(run.id) || run.id <= 0) {
            collectionReason = `CI 第 ${page} 页检查记录格式异常（缺少有效 id）`;
            break;
          }
          if (ids.has(run.id)) {
            collectionReason = `CI 第 ${page} 页包含重复检查 id`;
            break;
          }
          ids.add(run.id);
        }
        if (collectionReason) break;
        if (list.length === total) {
          complete = true;
          break;
        }
        if (pageRuns.length < perPage || page === maxPages) {
          truncated = true;
          collectionReason = `CI 检查列表被截断（已采集 ${list.length} / ${total}；${page === maxPages ? '达到分页上限' : '返回页不足 per_page'}）`;
          break;
        }
      }
      d.checks = summarizeChecks({ runs: list, headSha, complete, truncated, collectionReason });
    }
    // 叠式 PR 的分支提交会包含整段 base 历史，只留真正 ahead 的部分给节点证据
    if ((p.head?.ref?.startsWith('task/') || /pm:node=/.test(p.body || '')) && p.base?.ref && p.head?.sha) {
      try {
        const cmp = await ghApi(`repos/${repo}/compare/${p.base.ref}...${p.head.sha}`, { pages: 1, perPage: 100, retries: 2 });
        d.aheadShas = (cmp.commits || []).map((c) => c.sha.slice(0, 8));
        d.aheadBy = cmp.ahead_by ?? d.aheadShas.length;
      } catch (err) {
        log(`[ingest] PR #${p.number} ahead 读取失败: ${String(err.message).slice(0, 120)}`);
      }
    }
    pullDetails[p.number] = d;
  }

  const raw = {
    fetchedAt: new Date().toISOString(),
    repo: {
      full_name: meta.full_name,
      pushed_at: meta.pushed_at,
      default_branch: meta.default_branch,
      size: meta.size,
    },
    issues: issues.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      is_pr: Boolean(i.pull_request),
      body: i.body || '',
      user: i.user?.login,
      updated_at: i.updated_at,
      closed_at: i.closed_at,
      labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    })),
    pulls: pulls.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      draft: p.draft,
      merged_at: p.merged_at,
      head_ref: p.head?.ref,
      base_ref: p.base?.ref,
      head_sha: p.head?.sha,
      body: p.body || '',
      user: p.user?.login,
      updated_at: p.updated_at,
      created_at: p.created_at,
      additions: p.additions,
      deletions: p.deletions,
      changed_files: p.changed_files,
      commits: p.commits,
    })),
    branches: branches.map((b) => ({ name: b.name, sha: b.commit.sha })),
    branchCommits,
    pullDetails,
  };

  assertProjectLock(root, cfg.id, lock);
  const cacheDir = join(root, 'cache', cfg.id);
  mkdirSync(cacheDir, { recursive: true });
  writeJsonFile(join(cacheDir, 'raw.json'), raw);
  return raw;
}
