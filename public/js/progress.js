// PM 审计台 · 前端「进度页（关键路径 / 催办 / 按人）」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

function renderCritical() {
  const box = $('#critical');
  box.innerHTML = '';
  const cp = facts.criticalPath;
  if (!cp.path.length) {
    box.append(el('p', 'sub', '没有未完成节点。'));
    return;
  }
  const chain = el('div', 'chain');
  cp.path.forEach((id, i) => {
    if (i) chain.append(el('span', 'arrow', '→'));
    chain.append(el('span', 'n', id));
  });
  box.append(chain);
  const byId = new Map(facts.nodes.map((n) => [n.id, n]));
  const table = el('table');
  const head = el('tr');
  for (const h of ['节点', '负责人', '状态', '空闲', '下游']) head.append(el('th', '', h));
  const rows = pager(cp.path, 8, (tbody, id) => {
    const n = byId.get(id);
    const tr = el('tr');
    tr.append(el('td', 'mono', id), el('td', '', n.owner));
    const td = el('td');
    td.append(stateChip(n.state));
    tr.append(td, el('td', 'num', n.daysIdle == null ? '—' : `${n.daysIdle} 天`), el('td', 'num', String(n.downstream)));
    tbody.append(tr);
  }, 'tbody');
  const thead = el('thead');
  thead.append(head);
  table.append(thead, rows.body);
  box.append(table, rows.foot, el('p', 'sub', `剩余 ${cp.len} 人日（T 恤码估算，不是承诺）`));
}

function renderNextActions() {
  const box = $('#next-actions');
  if (!box || !facts) return;
  const data = NEXT_ACTIONS && isCurrent(NEXT_ACTIONS) ? NEXT_ACTIONS.data : null;
  if (!data) {
    box.innerHTML = '';
    box.append(el('p', 'sub', '正在整理下一步行动…'));
    return;
  }
  box.innerHTML = '';
  const actions = data.next || [];
  if (!actions.length) {
    box.append(el('p', 'sub', '当前没有需要优先处理的事项。'));
    return;
  }
  const head = el('div', 'next-head');
  head.append(el('h2', '', '先处理这 3 件事'), el('span', 'sub', `最多 3 项 · 按现有催办规则排序`));
  box.append(head);
  const grid = el('div', 'next-grid');
  for (const a of actions) {
    const card = el('button', 'next-card');
    const top = el('div', 'next-top');
    top.append(el('span', `kind kind-${a.kind === 'blocked-root' ? 'blocked' : a.kind}`, a.kindLabel));
    top.append(el('span', 'id', a.nodeId));
    if (a.owner) top.append(el('span', 'owner', `${a.owner}`));
    card.append(top);
    card.append(el('div', 'next-title', a.title));
    card.append(el('div', 'next-reason', a.reason));
    card.append(el('div', 'next-action', a.action));
    card.onclick = () => {
      const node = facts.nodes.find((n) => n.id === a.nodeId) || facts.nodes.find((n) => a.nodeIds?.includes(n.id));
      if (node) openDrawer(node);
    };
    grid.append(card);
  }
  box.append(grid);
}

async function renderBlockers() {
  const box = $('#blockers');
  if (!box || !facts || !currentId) return;
  if (ALERTS && isCurrent(ALERTS)) {
    paintAlerts(ALERTS.data);
    renderNextActions();
    return;
  }
  const ctx = projectContext();
  const request = ++alertsRequest;
  const active = () => isCurrent(ctx) && request === alertsRequest;
  box.innerHTML = '';
  box.append(el('p', 'sub', '正在生成催办清单…'));
  try {
    const res = await fetch(`/api/projects/${ctx.id}/alerts?t=` + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!active()) return;
    ALERTS = { ...ctx, data };
    NEXT_ACTIONS = { ...ctx, data };
    paintAlerts(data);
    renderNextActions();
  } catch (err) {
    if (!active()) return;
    box.innerHTML = '';
    box.append(el('p', 'sub', '催办清单不可用：' + err.message));
    $('#next-actions').replaceChildren(el('p', 'sub', '下一步行动暂不可用，请重新加载项目。'));
  }
}

function paintAlerts(data) {
  const c = data.counts || { total: 0, critical: 0, stale: 0, blocked: 0, ready: 0 };
  const chip = $('#alerts-count');
  chip.textContent = c.total ? `${c.total} 条催办` : '无需催办';
  chip.className = 'chip ' + (c.critical ? 'readonly' : c.total ? '' : 'ok');
  chip.title = `停滞 ${c.stale} ｜ 卡点 ${c.blocked} ｜ 待启动 ${c.ready}；关键路径 ${c.critical} 条`;
  const box = $('#blockers');
  box.innerHTML = '';
  const KIND = { stale: '停滞', blocked: '卡点', ready: '待启动' };
  const alerts = data.alerts || [];
  if (alerts.length) {
    const p = pager(alerts, 5, (list, a) => {
      const row = el('div', 'alert-row');
      const top = el('div', 'alert-top');
      top.append(el('span', `kind kind-${a.kind}`, KIND[a.kind] || a.kind));
      top.append(el('span', 'id', a.nodeId));
      top.append(el('span', 't', a.title));
      if (a.onCriticalPath) top.append(el('span', 'tag crit', '关键路径'));
      if (a.downstream) top.append(el('span', 'tag', `下游 ${a.downstream}`));
      row.append(top);
      const bottom = el('div', 'alert-bottom');
      bottom.append(el('span', 'alert-sug', a.suggestion));
      const copy = el('button', 'mini', '复制话术');
      copy.title = '复制一条催办话术，自己去发；PM 不代发';
      copy.onclick = async () => {
        const ok = await copyText(a.nudge, `${a.nodeId}.nudge.txt`);
        toast(ok ? `已复制 ${a.nodeId} 催办话术` : '剪贴板不可用，已改为下载话术');
      };
      bottom.append(copy);
      row.append(bottom);
      list.append(row);
    });
    p.body.classList.add('alerts-list');
    box.append(p.body, p.foot);
  } else {
    box.append(el('p', 'sub', '当前没有需要催办的节点。'));
  }
  if (facts.unlinked.length) {
    box.append(el('h4', 'sub', '计划外提交'));
    const list = el('div', 'list');
    for (const u of facts.unlinked.slice(0, 5)) {
      const row = el('div', 'row');
      row.append(el('span', 'id', '⌥'), el('span', 't', u.branch));
      row.append(el('span', 'tag', `${u.count} 条未关联`));
      const link = el('button', 'mini', '归位');
      link.title = '把这条分支的提交关联到某个节点（在 open PR 上留证据）';
      link.onclick = () => openLinker(u.branch);
      row.append(link);
      row.title = u.commits.map((c) => c.message).join('\n');
      list.append(row);
    }
    box.append(list);
  }
}

function renderPeople() {
  const box = $('#people');
  box.innerHTML = '';
  const table = el('table');
  table.className = 'people';
  const head = el('tr');
  for (const h of ['人', '完成', '进行', '阻塞', '人日', '提交']) head.append(el('th', '', h));
  table.append(head);
  const people = Object.entries(facts.people);
  if (!people.length) {
    box.append(el('p', 'sub', '这个项目没有配置成员。'));
    return;
  }
  for (const [id, p] of people) {
    const tr = el('tr');
    tr.append(
      el('td', '', `${id} ${p.name}`),
      el('td', 'num', `${p.done}/${p.total}`),
      el('td', 'num', String(p.active)),
      el('td', 'num', String(p.blocked)),
      el('td', 'num', String(p.remainingDays)),
      el('td', 'num', String(p.commitCount)),
    );
    table.append(tr);
  }
  box.append(table);
}
