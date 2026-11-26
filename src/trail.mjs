import { pmStamp, pmFooter, shortHash } from './brand.mjs';
import { summarizeChecks } from './ci.mjs';

const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '—');
const when = (v) => (v ? `${new Date(v).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—');
const STATE_ORDER = { done: 0, stale: 1, active: 2, blocked: 3, ready: 4 };
const STATE_LABEL = { done: '完成', active: '进行中', stale: '停滞', blocked: '被阻塞', ready: '待启动' };

export function buildTrail(bundle) {
  const repo = bundle.project.repo;
  const gh = `https://github.com/${repo}`;
  const branch = bundle.project.defaultBranch || 'main';
  const pullsByNumber = new Map((bundle.evidence?.pulls || []).map((p) => [p.number, p]));

  const nodes = bundle.facts.nodes
    .map((n) => {
      const prs = n.prs.map((p) => {
        const full = pullsByNumber.get(p.number) || {};
        // PR 列表接口不带 diff 统计；用 pullDetails 的文件清单补，
        // 但文件清单只拉一页（100 条），满页时可能截断，宁缺毋假。
        const detailFiles = bundle.evidence?.pullDetails?.[p.number]?.files;
        const complete = Array.isArray(detailFiles) && detailFiles.length > 0 && detailFiles.length < 100;
        const checks = summarizeChecks({
          runs: bundle.evidence?.pullDetails?.[p.number]?.checks?.checks || [],
          headSha: full.head_sha || null,
          complete: Boolean(bundle.evidence?.pullDetails?.[p.number]?.checks?.complete),
          truncated: Boolean(bundle.evidence?.pullDetails?.[p.number]?.checks?.truncated),
        });
        return {
          number: p.number,
          title: full.title || '',
          state: p.state,
          merged_at: p.merged_at || null,
          created_at: p.created_at || null,
          head_ref: p.head_ref || full.head_ref || null,
          base_ref: full.base_ref || null,
          head_sha: full.head_sha || null,
          additions: full.additions ?? (complete ? detailFiles.reduce((s, f) => s + (f.additions || 0), 0) : null),
          deletions: full.deletions ?? (complete ? detailFiles.reduce((s, f) => s + (f.deletions || 0), 0) : null),
          changed_files: full.changed_files ?? (complete ? detailFiles.length : null),
          commitCount: full.commits ?? null,
          pm_base: p.pm_base || null,
          checks,
          url: `${gh}/pull/${p.number}`,
        };
      });
      const mergedPr = prs.find((p) => p.merged_at) || null;
      const closedIssues = n.issues.filter((i) => i.state === 'closed');
      const commits = (n.commits || []).map((c) => ({ ...c, url: `${gh}/commit/${c.sha}` }));
      const files = (n.files || []).map((f) => ({
        path: f,
        url: f.endsWith('/') ? `${gh}/tree/${branch}/${f.slice(0, -1)}` : `${gh}/blob/${branch}/${f}`,
      }));
      let note = null;
      if (n.done && mergedPr && !commits.length) note = 'task 分支合并后已删除，完成证据以合并 PR 为准。';
      if (n.done && !mergedPr && closedIssues.length) note = '完成依据是 issue 关闭，没有合并 PR；证据强度较弱，复盘时注意。';
      return {
        id: n.id,
        title: n.title,
        owner: n.owner,
        ownerName: bundle.project.members?.[n.owner]?.name || null,
        state: n.state,
        acceptance: n.acceptance || '',
        doneVia: mergedPr ? 'merged-pr' : closedIssues.length ? 'closed-issue' : null,
        mergedPr,
        prs,
        issues: n.issues.map((i) => ({ ...i, url: `${gh}/issues/${i.number}` })),
        branch: n.branch,
        commits,
        files,
        daysIdle: n.daysIdle,
        blockedBy: n.blockedBy,
        downstream: n.downstream,
        onCriticalPath: n.onCriticalPath,
        note,
      };
    })
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.id.localeCompare(b.id));

  return {
    project: { id: bundle.project.id, name: bundle.project.name, repo },
    asOf: bundle.asOf,
    hash: bundle.hashes.facts,
    defaultBranch: branch,
    stats: bundle.facts.stats,
    nodes,
  };
}

const CI_LABEL = { passed: 'CI 已采集的全部成功', failed: 'CI 有失败', pending: 'CI 未完成', unknown: 'CI 未知' };

function ciLine(checks) {
  if (!checks) return 'CI：未采集';
  const suffix = checks.truncated ? '（列表可能截断）' : checks.complete ? '' : '（采集不完整）';
  return `CI：${CI_LABEL[checks.status] || checks.status}${suffix}`;
}

function prLine(p) {
  const bits = [`[PR #${p.number}](${p.url})`];
  bits.push(p.merged_at ? `合并于 ${day(p.merged_at)}` : p.state === 'open' ? '开放中' : p.state);
  if (p.head_ref) bits.push(`\`${p.head_ref}${p.base_ref ? ` → ${p.base_ref}` : ''}\``);
  if (p.additions != null) bits.push(`+${p.additions}/-${p.deletions}（${p.changed_files} 文件）`);
  if (p.head_sha) bits.push(`head \`${String(p.head_sha).slice(0, 8)}\``);
  if (p.checks) bits.push(ciLine(p.checks));
  return bits.join(' ｜ ');
}

export function renderTrail(bundle, verify) {
  const trail = buildTrail(bundle);
  const L = [];
  const push = (...a) => L.push(...a);
  push(`# [PM] ${trail.project.name} 证据链审计`, '');
  push(pmStamp({ kind: '证据链', project: trail.project, asOf: trail.asOf, hash: trail.hash }));
  push('');
  if (verify) {
    push(
      verify.ok
        ? `- 指纹校验：**重算一致** ✓（\`${trail.hash}\`）——本报告的每个状态都能从包内证据重新推出。`
        : `- 指纹校验：**不一致** ✗（包内 ${shortHash(verify.expected)} ≠ 重算 ${shortHash(verify.actual)}），本报告仅供排查，不要当作可信进度。`,
    );
  }
  push(`- 数据基准：${when(trail.asOf)} ｜ 仓库 ${trail.project.repo} ｜ 完成 ${trail.stats.done}/${trail.stats.nodes}`);
  push('- 判完成只认两种证据：PR 合并、issue 关闭。口头汇报、本地提交都不算。');
  push('');

  const done = trail.nodes.filter((n) => n.state === 'done');
  push(`## 一、已完成（${done.length}）`, '');
  if (!done.length) push('还没有节点完成。', '');
  for (const n of done) {
    push(`### ${n.id} · ${n.title}（${n.owner}${n.ownerName ? ` ${n.ownerName}` : ''}）`, '');
    push(`- 验收标准：${n.acceptance || '（计划里没写）'}`);
    for (const p of n.prs.filter((x) => x.merged_at)) push(`- 完成证据：${prLine(p)}`);
    for (const p of n.prs.filter((x) => !x.merged_at)) push(`- 关联 PR：${prLine(p)}`);
    for (const i of n.issues) push(`- issue：[#${i.number}](${i.url})（${i.state}）${i.title}`);
    if (n.commits.length) {
      push(`- 提交（${n.commits.length}）：`);
      for (const c of n.commits.slice(0, 8)) push(`  - [\`${c.sha}\`](${c.url}) ${day(c.date)} ${c.message}`);
    }
    if (n.note) push(`- 说明：${n.note}`);
    if (n.files.length) push(`- 证据文件：${n.files.map((f) => `[${f.path}](${f.url})`).join('、')}`);
    const bases = n.prs.map((p) => p.pm_base).filter(Boolean);
    if (bases.length) push(`- 简报基准：${bases.map((b) => `\`${shortHash(b)}\``).join('、')}（pm:base 声明）`);
    push('');
  }

  const working = trail.nodes.filter((n) => n.state === 'active' || n.state === 'stale');
  push(`## 二、进行中 / 停滞（${working.length}）`, '');
  if (!working.length) push('无。', '');
  for (const n of working) {
    push(`### ${n.id} · ${n.title}（${n.owner}）— ${STATE_LABEL[n.state]}${n.daysIdle != null ? `，空闲 ${n.daysIdle} 天` : ''}`, '');
    push(`- 验收标准：${n.acceptance || '（计划里没写）'}`);
    for (const p of n.prs) push(`- PR：${prLine(p)}`);
    if (n.branch) push(`- 分支：\`${n.branch}\``);
    for (const c of n.commits.slice(0, 5)) push(`- 提交：[\`${c.sha}\`](${c.url}) ${day(c.date)} ${c.message}`);
    if (!n.prs.length && !n.commits.length) push('- 还没有任何提交或 PR 证据。');
    push('');
  }

  const rest = trail.nodes.filter((n) => n.state === 'blocked' || n.state === 'ready');
  push(`## 三、待启动 / 被阻塞（${rest.length}）`, '');
  if (rest.length) {
    push('| 节点 | 任务 | 负责人 | 状态 | 在等 | 下游 |', '|---|---|---|---|---|---|');
    for (const n of rest) {
      push(`| ${n.id} | ${n.title} | ${n.owner} | ${STATE_LABEL[n.state]} | ${n.blockedBy.join('、') || '—'} | ${n.downstream} |`);
    }
  } else push('无。');
  push('');
  push(pmFooter());
  return `${L.join('\n')}\n`;
}