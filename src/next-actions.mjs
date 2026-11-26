import { buildAlerts } from './alerts.mjs';

const KIND_LABEL = { stale: '停滞', blocked: '卡点', ready: '待启动' };

export function buildNextActions(facts, cfg = {}, limit = 3) {
  if (!facts?.nodes?.length) return [];
  const byId = new Map(facts.nodes.map((n) => [n.id, n]));
  const isDone = (n) => n?.state === 'done' || n?.done === true;
  const depsOf = (n) => n.deps ?? n.blockedBy ?? [];
  // Missing dependencies remain unfinished, but can never become invented roots.
  const unfinishedDeps = (n) => depsOf(n).filter((id) => !isDone(byId.get(id)));
  const actionable = (n) => n && !isDone(n) &&
    ['ready', 'active', 'stale'].includes(n.state) && unfinishedDeps(n).length === 0;

  const dependents = new Map(facts.nodes.map((n) => [n.id, []]));
  for (const n of facts.nodes) for (const dep of depsOf(n)) dependents.get(dep)?.push(n.id);
  const downstreamOf = (id) => {
    const seen = new Set([id]);
    const pending = [...(dependents.get(id) || [])];
    while (pending.length) {
      const child = pending.pop();
      if (seen.has(child)) continue;
      seen.add(child);
      pending.push(...(dependents.get(child) || []));
    }
    return [...seen].filter((child) => child !== id && !isDone(byId.get(child)))
      .sort((a, b) => a.localeCompare(b));
  };

  const alerts = buildAlerts(facts, cfg);
  const actions = new Map();
  const pending = [];
  for (const alert of alerts) {
    if (alert.kind === 'blocked') {
      pending.push(alert.nodeId);
      continue;
    }
    // Stale can take precedence over blocked in facts; only retain actionable alerts.
    if (!actionable(byId.get(alert.nodeId))) continue;
    const bits = [alert.message];
    if (alert.downstream) bits.push(`下游 ${alert.downstream} 个未完成节点`);
    if (alert.onCriticalPath) bits.push('在关键路径上');
    actions.set(alert.nodeId, {
      key: `${alert.kind}:${alert.nodeId}`,
      nodeId: alert.nodeId,
      title: alert.title,
      owner: alert.owner || null,
      kind: alert.kind,
      kindLabel: KIND_LABEL[alert.kind] || alert.kind,
      reason: bits.join('；'),
      action: alert.suggestion,
      downstream: alert.downstream || 0,
      onCriticalPath: alert.onCriticalPath || false,
      priority: alert.priority || 0,
    });
  }

  // Walk every blocked alert back to real, unfinished, dependency-free roots.
  // A shared visited set handles diamonds, shared roots and dependency cycles.
  const visited = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (!node || isDone(node)) continue;
    const unfinished = unfinishedDeps(node);
    if (unfinished.length) {
      pending.push(...unfinished);
      continue;
    }
    if (!actionable(node) || actions.has(id)) continue;

    const nodeIds = downstreamOf(id);
    const title = node.title || id;
    const owner = node.owner || null;
    const onCriticalPath = Boolean(node.onCriticalPath);
    actions.set(id, {
      key: `blocked:${id}`,
      nodeId: id,
      nodeIds,
      title,
      owner,
      kind: 'blocked-root',
      kindLabel: '先推前置',
      reason: [
        `${id}「${title}」尚未完成`,
        `下游 ${nodeIds.length} 个未完成节点`,
        onCriticalPath ? '在关键路径上' : '',
      ].filter(Boolean).join('；'),
      action: `${owner ? '让 ' + owner + ' ' : ''}先完成 ${id}「${title}」，再推进依赖它的后继`,
      downstream: nodeIds.length,
      onCriticalPath,
      // Keep the alert weights: critical path, unique downstream, then kind.
      priority: (onCriticalPath ? 1000 : 0) + nodeIds.length * 20 + 6,
      owners: owner || id,
    });
  }

  return [...actions.values()]
    .sort((a, b) => b.priority - a.priority || a.nodeId.localeCompare(b.nodeId))
    .slice(0, Math.max(0, Math.min(3, limit)));
}
