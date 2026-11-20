import { pmStamp, pmFooter } from './brand.mjs';

const KIND_LABEL = { stale: '停滞', blocked: '卡点', ready: '待启动' };
const KIND_WEIGHT = { stale: 3, ready: 2, blocked: 1 };

// 从审计事实里挑出需要人催一把的节点：停滞（手上活停了）、卡点（被前置挡住）、
// 待启动（没人动却卡着下游）。只在本机提醒，不自动往 GitHub 发任何东西。
export function buildAlerts(facts, cfg = {}) {
  const staleDays = cfg.staleDays ?? 5;
  const byId = new Map(facts.nodes.map((n) => [n.id, n]));
  const alerts = [];
  for (const n of facts.nodes) {
    if (n.done) continue;
    const base = {
      nodeId: n.id,
      title: n.title,
      owner: n.owner || null,
      downstream: n.downstream || 0,
      onCriticalPath: Boolean(n.onCriticalPath),
    };
    if (n.state === 'stale') {
      const openPr = (n.prs || []).find((p) => p.state === 'open');
      alerts.push({
        ...base,
        kind: 'stale',
        daysIdle: n.daysIdle,
        openPr: openPr?.number || null,
        message: `${n.id}「${n.title}」已 ${n.daysIdle} 天没动静（停滞阈值 ${staleDays} 天）`,
        suggestion: openPr
          ? `PR #${openPr.number} 还开着：催评审/合并，或说明卡在哪`
          : `${n.owner ? '让 ' + n.owner + ' ' : '负责人'}继续推，或确认是否卡住`,
      });
    } else if (n.state === 'blocked') {
      const blockedBy = n.blockedBy || [];
      const blockerOwners = [...new Set(blockedBy.map((d) => byId.get(d)?.owner).filter(Boolean))];
      alerts.push({
        ...base,
        kind: 'blocked',
        blockedBy,
        blockerOwners,
        message: `${n.id}「${n.title}」被 ${blockedBy.join('、')} 卡住`,
        suggestion: blockerOwners.length
          ? `先推 ${blockerOwners.join('、')} 完成 ${blockedBy.join('、')}`
          : `先完成前置 ${blockedBy.join('、')}`,
      });
    } else if (n.state === 'ready' && (base.downstream > 0 || base.onCriticalPath)) {
      alerts.push({
        ...base,
        kind: 'ready',
        message: `${n.id}「${n.title}」可以开工但还没人动`,
        suggestion: `${n.owner ? '让 ' + n.owner + ' ' : '认领后'}尽快启动${base.downstream ? `，它卡住 ${base.downstream} 个下游` : ''}`,
      });
    }
  }
  for (const a of alerts) {
    a.priority =
      (a.onCriticalPath ? 1000 : 0) +
      a.downstream * 20 +
      KIND_WEIGHT[a.kind] * 5 +
      (a.kind === 'stale' ? Math.min(a.daysIdle || 0, 30) : 0);
    a.nudge = nudgeText(a);
  }
  alerts.sort((x, y) => y.priority - x.priority || x.nodeId.localeCompare(y.nodeId));
  return alerts;
}

export function alertCounts(alerts) {
  const c = { stale: 0, blocked: 0, ready: 0, total: alerts.length, critical: 0 };
  for (const a of alerts) {
    c[a.kind] += 1;
    if (a.onCriticalPath) c.critical += 1;
  }
  return c;
}

// 给人复制去手动发的催办话术；PM 不代发。
export function nudgeText(a) {
  const who = a.owner ? `@${a.owner} ` : '';
  const crit = a.onCriticalPath ? '（关键路径）' : '';
  if (a.kind === 'stale') return `${who}${a.nodeId}「${a.title}」停了 ${a.daysIdle} 天${crit}，${a.suggestion}。`;
  if (a.kind === 'blocked') return `${who}${a.nodeId}「${a.title}」被 ${a.blockedBy.join('、')} 卡住${crit}，${a.suggestion}。`;
  return `${who}${a.nodeId}「${a.title}」还没开工${crit}，${a.suggestion}。`;
}

export function renderAlerts(facts, alerts, project = {}) {
  const L = [];
  const push = (...x) => L.push(...x);
  push(`# [PM] ${project.name || facts.project || ''} 催办清单`, '');
  push(pmStamp({ kind: '催办', project, asOf: facts.asOf, hash: project.hash }));
  push('');
  const c = alertCounts(alerts);
  push(`- 共 ${c.total} 条：停滞 ${c.stale} ｜ 卡点 ${c.blocked} ｜ 待启动 ${c.ready}；其中关键路径 ${c.critical} 条。`);
  push('- 本机提醒，不会自动发到 GitHub。要催谁，复制话术自己发。');
  push('');
  if (!alerts.length) {
    push('当前没有需要催办的节点。', '');
    push(pmFooter());
    return `${L.join('\n')}\n`;
  }
  alerts.forEach((a, i) => {
    push(`${i + 1}. ${a.onCriticalPath ? '★ ' : ''}${KIND_LABEL[a.kind]} · ${a.nodeId}「${a.title}」· ${a.owner || '无负责人'}${a.downstream ? ` · 下游 ${a.downstream}` : ''}`);
    push(`   ${a.message} → ${a.suggestion}`);
  });
  push('');
  push(pmFooter());
  return `${L.join('\n')}\n`;
}