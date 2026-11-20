import { pmStamp, pmFooter } from './brand.mjs';

const short = (s, n = 16) => (s.length > n ? `${s.slice(0, n)}…` : s);
const esc = (s) => s.replace(/"/g, "'");
const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '—');
const when = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');

export function renderMermaid(facts) {
  const lines = ['%% [PM] 自动生成 · 不要手改', 'graph TD'];
  lines.push('  classDef done fill:#d3f9d8,stroke:#2b8a3e,color:#1b4332');
  lines.push('  classDef active fill:#d0ebff,stroke:#1864ab,color:#0b3d6b');
  lines.push('  classDef stale fill:#ffe8cc,stroke:#d9480f,color:#7a2e00');
  lines.push('  classDef blocked fill:#ffe3e3,stroke:#c92a2a,color:#7a1010');
  lines.push('  classDef ready fill:#f1f3f5,stroke:#868e96,color:#343a40');
  for (const n of facts.nodes) {
    lines.push(`  ${n.id}["${esc(`${n.id} ${short(n.title)}（${n.owner}）`)}"]:::${n.state}`);
  }
  for (const n of facts.nodes) {
    for (const d of n.deps) lines.push(`  ${d} --> ${n.id}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderAudit(facts, cfg, planSource) {
  const s = facts.stats;
  const byId = new Map(facts.nodes.map((n) => [n.id, n]));
  const L = [];
  const push = (...a) => L.push(...a);

  push(`# [PM] ${facts.project} 进度审计`, '');
  push(pmStamp({ kind: '进度审计', project: facts.project, asOf: facts.asOf }));
  push('');
  push(`- 数据基准：${when(facts.asOf)}`);
  push(`- 数据截止：${when(facts.fetchedAt)}（远程 ${facts.repo.full_name} 最后推送 ${when(s.remotePushedAt)}）`);
  push(`- 计划来源：${planSource}`);
  push(`- 图规模：${s.nodes} 个节点，已挂 issue ${s.withIssues} 个（覆盖率 ${(s.issueCoverage * 100).toFixed(0)}%），已挂 task 分支 ${facts.nodes.filter((n) => n.branch).length} 个`);
  push('');

  push('## 一、状态总览', '');
  push('| 完成 | 进行中 | 停滞 | 被阻塞 | 待启动 |', '|---|---|---|---|---|');
  push(`| ${s.done} | ${s.active} | ${s.stale} | ${s.blocked} | ${s.ready} |`, '');

  push('## 二、计划 vs 证据（按人）', '');
  push('| 人 | 完成/总 | 进行中 | 阻塞 | 待启动 | 剩余工作量(人日) | 远程提交 | 最近提交 |', '|---|---|---|---|---|---|---|---|');
  for (const [id, p] of Object.entries(facts.people)) {
    push(`| ${id} ${p.name} | ${p.done}/${p.total} | ${p.active} | ${p.blocked} | ${p.ready} | ${p.remainingDays} | ${p.commitCount} | ${day(p.lastCommit)} |`);
  }
  push('');
  for (const [id, p] of Object.entries(facts.people)) {
    if (p.commitCount === 0) {
      push(`> ${id} 线在远程仓库 ${cfg.commitWindowDays} 天内没有提交记录。若工作发生在本地或云控制台，需要把证据（日志/截图/manifest）落库，否则进度不可审计。`);
      push('');
    }
  }

  push('## 三、关键路径', '');
  if (facts.criticalPath.path.length) {
    push(`\`${facts.criticalPath.path.join(' → ')}\`，剩余 ${facts.criticalPath.len} 人日`, '');
    push('| 节点 | 任务 | 负责人 | 状态 | 空闲天数 | 下游 |', '|---|---|---|---|---|---|');
    for (const id of facts.criticalPath.path) {
      const n = byId.get(id);
      push(`| ${id} | ${short(n.title, 28)} | ${n.owner} | ${n.state} | ${n.daysIdle ?? '—'} | ${n.downstream} |`);
    }
  } else {
    push('未完成节点为空，或依赖配置有误。');
  }
  push('');

  push('## 四、卡点', '');
  const blocked = facts.nodes.filter((n) => n.state === 'blocked').sort((a, b) => b.downstream - a.downstream);
  const stale = facts.nodes.filter((n) => n.state === 'stale').sort((a, b) => (b.daysIdle || 0) - (a.daysIdle || 0));
  if (blocked.length) {
    push('**阻塞链**', '');
    for (const n of blocked.slice(0, 8)) {
      push(`- ${n.id} ${short(n.title, 26)}：在等 ${n.blockedBy.join('、')}；下游还有 ${n.downstream} 个节点`);
    }
    push('');
  }
  if (stale.length) {
    push('**停滞**', '');
    for (const n of stale.slice(0, 8)) {
      push(`- ${n.id} ${short(n.title, 26)}：已 ${n.daysIdle} 天无新提交（最后 ${day(n.lastActivity)}），负责人 ${n.owner}`);
    }
    push('');
  }
  if (facts.unlinked.length) {
    push('**计划外提交（未关联任何任务节点）**', '');
    for (const u of facts.unlinked.sort((a, b) => b.count - a.count).slice(0, 8)) {
      push(`- \`${u.branch}\`：${u.count} 条，例如 "${short(u.commits[0]?.message || '', 40)}"`);
    }
    push('');
  }
  if (!blocked.length && !stale.length) push('无阻塞、无停滞。', '');

  push('## 五、今日建议（规则版，未接 LLM）', '');
  const advice = [];
  const head = facts.criticalPath.path[0] ? byId.get(facts.criticalPath.path[0]) : null;
  if (head && (head.state === 'ready' || head.state === 'blocked')) {
    advice.push(`关键路径起点 ${head.id} 还没有任何提交，今天先把它启动（${short(head.title, 30)}）。`);
  }
  for (const n of blocked.slice(0, 3)) {
    if (n.downstream >= 2) advice.push(`${n.id} 卡住 ${n.downstream} 个下游，优先解除它的依赖。`);
  }
  for (const n of stale.slice(0, 3)) advice.push(`${n.id} 停了 ${n.daysIdle} 天，问一句是卡住还是忘更新。`);
  if (s.issueCoverage < 0.5) {
    advice.push(`只有 ${s.withIssues}/${s.nodes} 个节点有 issue：建议至少给关键路径上的节点建 issue，否则进度只能靠分支和提交推断。`);
  }
  const noTrace = Object.entries(facts.people).filter(([, p]) => p.commitCount === 0);
  for (const [id, p] of noTrace) advice.push(`${id} 线（${p.name}）远程零提交，确认工作是否只在本地；否则审计会一直判它没动。`);
  if (facts.unlinked.length) {
    advice.push(`有 ${facts.unlinked.reduce((a, u) => a + u.count, 0)} 条提交没挂任务标签：约定分支名 task/<节点号> 或提交带 [A2] 标记，就能自动归属。`);
  }
  for (const a of advice.slice(0, 6)) push(`- ${a}`);
  if (!advice.length) push('- 无。');
  push('');

  push('## 附：节点明细', '');
  push('| 节点 | 任务 | 负责人 | 工期 | 状态 | 依赖 | 证据 |', '|---|---|---|---|---|---|---|');
  for (const n of facts.nodes) {
    const ev = [
      ...n.issues.map((i) => `#${i.number}(${i.state})`),
      ...n.prs.map((p) => `PR#${p.number}${p.merged_at ? '✓' : ''}`),
      n.branch ? `分支:${n.branch}` : null,
      n.commits.length ? `${n.commits.length} commits` : null,
    ].filter(Boolean);
    push(`| ${n.id} | ${short(n.title, 34)} | ${n.owner} | ${n.est} | ${n.state} | ${n.deps.join(' ') || '—'} | ${ev.join(' ') || '无'} |`);
  }
  push('');
  push(pmFooter());
  return `${L.join('\n')}\n`;
}
