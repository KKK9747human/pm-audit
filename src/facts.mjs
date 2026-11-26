const DAY = 86400000;
const EST = { S: 1, M: 3, L: 8 };

const daysBetween = (a, b) => Math.floor((a - b) / DAY);
const ts = (v) => (v ? new Date(v).getTime() : 0);
const markerOf = (text) => {
  const m = /pm:node=([A-Za-z0-9_-]+)/.exec(text || '');
  return m ? m[1] : null;
};
const baseOf = (text) => {
  const m = /<!--\s*pm:base=([A-Za-z0-9:._-]+)\s*-->/i.exec(text || '');
  return m ? m[1] : null;
};
const tagOf = (text) => {
  const m = /\[([A-C]\d+)\]/.exec(text || '');
  return m ? m[1] : null;
};

export function buildFacts(plan, raw, cfg, asOf) {
  const now = asOf ? new Date(asOf).getTime() : Date.parse(raw.fetchedAt) || Date.now();
  const nodes = plan.nodes.map((n) => ({ ...n, days: EST[n.est] ?? 3 }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const issues = raw.issues.filter((i) => !i.is_pr);
  const prs = raw.pulls;

  for (const n of nodes) {
    n.issues = issues
      .filter((i) => markerOf(i.body) === n.id || tagOf(i.title) === n.id)
      .sort((a, b) => a.number - b.number);
    n.prs = prs
      .filter((p) => p.head_ref === `task/${n.id}` || markerOf(p.body) === n.id || tagOf(p.title) === n.id)
      .sort((a, b) => a.number - b.number);
    n.branch = raw.branchCommits.find((b) => b.name === `task/${n.id}`) || null;

    const fromBranch = n.branch?.commits || [];
    const tagged = raw.branchCommits
      .flatMap((b) => b.commits.map((c) => ({ ...c, branch: b.name })))
      .filter((c) => tagOf(c.message) === n.id);

    // task 分支常从别人的 base 分支长出来，分支提交里会带整段 base 历史。
    // 扣掉 base 分支上的提交和 PR ahead 集合之外的提交，节点证据才只算自己的活。
    const inherited = new Set();
    const baseRefs = new Set(n.prs.map((p) => p.base_ref).filter(Boolean));
    for (const b of raw.branchCommits) {
      if (baseRefs.has(b.name)) for (const c of b.commits) inherited.add(c.sha);
    }
    for (const p of n.prs) {
      const ahead = raw.pullDetails?.[p.number]?.aheadShas;
      if (!Array.isArray(ahead)) continue;
      const aheadSet = new Set(ahead);
      const head = raw.branchCommits.find((b) => b.name === p.head_ref);
      if (head) for (const c of head.commits) if (!aheadSet.has(c.sha)) inherited.add(c.sha);
    }

    const seen = new Set();
    n.commits = [...fromBranch, ...tagged]
      .filter((c) => {
        if (inherited.has(c.sha)) return false;
        if (seen.has(c.sha)) return false;
        seen.add(c.sha);
        return true;
      })
      .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || a.sha.localeCompare(b.sha));

    const activations = [
      ...n.commits.map((c) => ts(c.date)),
      ...n.issues.map((i) => ts(i.updated_at)),
      ...n.prs.map((p) => ts(p.updated_at)),
    ].filter(Boolean);
    n.lastActivity = activations.length ? Math.max(...activations) : 0;
    n.daysIdle = n.lastActivity ? daysBetween(now, n.lastActivity) : null;

    n.done = n.issues.some((i) => i.state === 'closed') || n.prs.some((p) => Boolean(p.merged_at));
    n.openPr = n.prs.find((p) => p.state === 'open') || null;
    n.prMerged = n.prs.find((p) => p.merged_at) || null;
    n.hasWork = n.commits.length > 0 || Boolean(n.openPr);
  }

  for (const n of nodes) {
    n.blockedBy = n.deps.filter((d) => !byId.get(d)?.done);
    n.active = !n.done && (Boolean(n.openPr) || (n.hasWork && n.daysIdle !== null && n.daysIdle <= cfg.activeWindowDays));
    n.blocked = !n.done && !n.active && n.blockedBy.length > 0;
    n.stale = !n.done && n.hasWork && n.daysIdle !== null && n.daysIdle > cfg.staleDays;
    n.state = n.done
      ? 'done'
      : n.stale
        ? 'stale'
        : n.active
          ? 'active'
          : n.blocked
            ? 'blocked'
            : 'ready';
  }

  // 下游依赖数（还有多少未完成节点在等它）
  const dependents = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const d of n.deps) dependents.get(d)?.push(n.id);
  const dependentSet = (id, seen = new Set()) => {
    for (const child of dependents.get(id) || []) {
      if (seen.has(child) || child === id) continue;
      seen.add(child);
      dependentSet(child, seen);
    }
    return seen;
  };
  for (const n of nodes) {
    n.downstream = n.done ? 0 : [...dependentSet(n.id)].filter((c) => !byId.get(c)?.done).length;
  }

  // 关键路径：未完成子图上按工期求最长链
  const memo = new Map();
  function longest(id, stack = new Set()) {
    if (memo.has(id)) return memo.get(id);
    if (stack.has(id)) return { len: 0, path: [] };
    stack.add(id);
    const n = byId.get(id);
    if (!n || n.done) {
      memo.set(id, { len: 0, path: [] });
      return memo.get(id);
    }
    let best = { len: 0, path: [] };
    for (const d of n.deps) {
      if (byId.get(d)?.done) continue;
      const r = longest(d, stack);
      if (r.len > best.len) best = r;
    }
    const res = { len: best.len + n.days, path: [...best.path, id] };
    memo.set(id, res);
    stack.delete(id);
    return res;
  }
  let critical = { len: 0, path: [] };
  for (const n of nodes) {
    if (n.done) continue;
    const r = longest(n.id);
    if (r.len > critical.len) critical = r;
  }
  for (const n of nodes) n.onCriticalPath = critical.path.includes(n.id);

  // 计划外提交：没落在 task/* 分支、也没有任务标签
  const unlinked = new Map();
  const allCommits = raw.branchCommits.flatMap((b) => b.commits.map((c) => ({ ...c, branch: b.name })));
  const seenSha = new Set();
  for (const c of allCommits) {
    if (seenSha.has(c.sha) || c.parents >= 2) continue;
    if (c.branch.startsWith('task/') || tagOf(c.message)) continue;
    seenSha.add(c.sha);
    const arr = unlinked.get(c.branch) || [];
    arr.push(c);
    unlinked.set(c.branch, arr);
  }

  // 人维度
  const people = {};
  for (const [id, m] of Object.entries(cfg.members)) {
    const own = nodes.filter((n) => n.owner === id);
    const ownCommits = allCommits.filter(
      (c) => m.github && c.author && c.author.toLowerCase() === m.github.toLowerCase(),
    );
    people[id] = {
      ...m,
      total: own.length,
      done: own.filter((n) => n.done).length,
      active: own.filter((n) => n.state === 'active' || n.state === 'stale').length,
      blocked: own.filter((n) => n.state === 'blocked').length,
      ready: own.filter((n) => n.state === 'ready').length,
      remainingDays: own.filter((n) => !n.done).reduce((s, n) => s + n.days, 0),
      criticalNodes: own.filter((n) => n.onCriticalPath).map((n) => n.id),
      commitCount: ownCommits.length,
      lastCommit: ownCommits.sort((a, b) => ts(b.date) - ts(a.date))[0]?.date || null,
    };
  }

  const withIssues = nodes.filter((n) => n.issues.length > 0).length;
  const counts = { done: 0, active: 0, stale: 0, blocked: 0, ready: 0 };
  for (const n of nodes) counts[n.state] += 1;

  return {
    asOf: new Date(now).toISOString(),
    fetchedAt: raw.fetchedAt,
    repo: raw.repo,
    project: plan.project,
    nodes: nodes.map((n) => ({
      id: n.id,
      title: n.title,
      owner: n.owner,
      est: n.est,
      days: n.days,
      deps: n.deps,
      blockedBy: n.blockedBy,
      state: n.state,
      done: n.done,
      issues: n.issues.map((i) => ({ number: i.number, state: i.state, title: i.title, updated_at: i.updated_at })),
      prs: n.prs.map((p) => ({ number: p.number, state: p.state, merged_at: p.merged_at, updated_at: p.updated_at, created_at: p.created_at, head_ref: p.head_ref, pm_base: baseOf(p.body) })),
      branch: n.branch?.name || null,
      commits: n.commits.slice(0, 10),
      lastActivity: n.lastActivity || null,
      daysIdle: n.daysIdle,
      downstream: n.downstream,
      onCriticalPath: n.onCriticalPath,
      acceptance: n.acceptance,
      files: n.files,
      // 可选的"怎么验证"字段：计划里填了才会出现在简报里，没填就写"计划未给出"。
      verify: Array.isArray(n.verify) && n.verify.length ? n.verify : null,
      env: Array.isArray(n.env) && n.env.length ? n.env : null,
      runtimeDeps: Array.isArray(n.runtimeDeps) && n.runtimeDeps.length ? n.runtimeDeps : null,
    })),
    criticalPath: critical,
    people,
    unlinked: [...unlinked.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([branch, cs]) => ({
        branch,
        count: cs.length,
        commits: [...cs].sort((x, y) => (Date.parse(y.date) || 0) - (Date.parse(x.date) || 0) || x.sha.localeCompare(y.sha)).slice(0, 8),
      })),
    stats: {
      nodes: nodes.length,
      ...counts,
      withIssues,
      issueCoverage: withIssues / nodes.length,
      branchCoverage: nodes.filter((n) => n.branch).length / nodes.length,
      openPrs: prs.filter((p) => p.state === 'open').length,
      mergedPrs: prs.filter((p) => p.merged_at).length,
      remotePushedAt: raw.repo.pushed_at,
    },
  };
}
