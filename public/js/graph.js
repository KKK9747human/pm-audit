// PM 审计台 · 前端「任务依赖图」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

function renderStats() {
  const s = facts.stats;
  const total = s.nodes || 0;
  const parts = [
    ['done', s.done, '完成', 'var(--green)'],
    ['active', s.active, '进行中', 'var(--cyan)'],
    ['stale', s.stale, '停滞', 'var(--amber)'],
    ['blocked', s.blocked, '被阻塞', 'var(--red)'],
    ['ready', s.ready, '待启动', 'var(--muted)'],
  ];
  const box = $('#stats');
  box.innerHTML = '';
  const bar = el('div', 'statbar');
  if (total > 0) {
    for (const [key, count, label, color] of parts) {
      if (!count) continue;
      const seg = el('div', 'seg');
      seg.style.width = `${(count / total) * 100}%`;
      seg.style.background = color;
      seg.title = `${label} ${count}/${total}`;
      bar.append(seg);
    }
  } else {
    bar.append(el('div', 'seg empty'));
  }
  const line = el('div', 'statline');
  line.append(el('span', 'total', `共 ${total} 节点`));
  for (const [key, count, label] of parts) {
    const pct = total && count ? `（${Math.round((count / total) * 100)}%）` : '';
    line.append(el('span', `sl-${key}`, `${label} ${count}${pct}`));
  }
  line.append(el('span', 'sl-issue', `issue 覆盖 ${s.withIssues}/${total}`));
  box.append(bar, line);
}

function renderNotice() {
  const msgs = [];
  if (facts.stats.withIssues === 0) msgs.push(`这张计划里 ${facts.stats.nodes} 个节点都没有挂 issue，状态只能靠分支和提交推断。`);
  for (const [id, p] of Object.entries(facts.people)) {
    if (p.commitCount === 0) msgs.push(`${id} 线（${p.name}）在远程仓库近期零提交。`);
  }
  const oldBase = [];
  for (const n of facts.nodes) {
    for (const p of n.prs || []) {
      if (p.state === 'open' && baseState(p, currentHash) === 'old') oldBase.push(`#${p.number}`);
    }
  }
  if (oldBase.length) {
    msgs.push(
      `${oldBase.length} 个 open PR 声明的简报基准已过期（${oldBase.slice(0, 3).join('、')}${oldBase.length > 3 ? ' 等' : ''}），让 agent 同步后再继续。`,
    );
  }
  const box = $('#notice');
  box.hidden = msgs.length === 0;
  box.textContent = msgs.join(' ');
}

function renderFilters() {
  const box = $('#filters');
  box.innerHTML = '';
  const owners = ['all', ...Object.keys(facts.people)];
  const mine = IDENTITY?.memberId;
  if (mine && facts.people[mine]) owners.splice(1, 0, 'mine');
  if (owners.length <= 2) return;
  for (const o of owners) {
    const label = o === 'all' ? '全部' : o === 'mine' ? '我的' : o;
    const b = el('button', filter === o ? 'on' : '', label);
    b.onclick = () => {
      filter = o;
      renderFilters();
      renderGraph();
    };
    box.append(b);
  }
}

function ownerMatch(o) {
  if (filter === 'all') return true;
  if (filter === 'mine') return Boolean(IDENTITY?.memberId) && o === IDENTITY.memberId;
  return o === filter;
}

function renderLegend() {
  const box = $('#legend');
  box.innerHTML = '';
  for (const st of ['done', 'active', 'stale', 'blocked', 'ready']) {
    const s = el('span');
    const i = el('i');
    i.style.background = FILL[st];
    i.style.border = `1px solid ${STROKE[st]}`;
    s.append(i, document.createTextNode(LABEL[st]));
    box.append(s);
  }
  const cp = el('span');
  const bar = el('i');
  bar.style.background = '#d29922';
  bar.style.width = '3px';
  bar.style.height = '12px';
  cp.append(bar, document.createTextNode('关键路径'));
  box.append(cp);
}

function layout(nodes, avail) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map();
  const visit = (id, stack = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    const n = byId.get(id);
    const deps = n.deps.filter((d) => byId.has(d));
    const d = deps.length ? Math.max(...deps.map((x) => visit(x, stack))) + 1 : 0;
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => visit(n.id));
  const layers = [];
  for (const n of nodes) {
    const d = depth.get(n.id) || 0;
    (layers[d] = layers[d] || []).push(n);
  }
  layers.forEach((l) =>
    l.sort((a, b) => String(a.owner).localeCompare(String(b.owner)) || a.id.localeCompare(b.id)),
  );
  const W = 172, H = 54, GX = 20, GY = 16, ROW_GAP = 6, PAD = 16;
  const width = Math.max(300, Math.floor(avail || 960));
  const MAX_PER_ROW = Math.max(1, Math.min(8, Math.floor((width - PAD * 2 + GX) / (W + GX))));
  const pos = new Map();
  let cursorY = PAD;
  for (const layer of layers) {
    if (!layer || !layer.length) continue;
    const rows = [];
    for (let i = 0; i < layer.length; i += MAX_PER_ROW) rows.push(layer.slice(i, i + MAX_PER_ROW));
    rows.forEach((row, r) => {
      const totalW = row.length * W + (row.length - 1) * GX;
      const startX = (width - totalW) / 2;
      row.forEach((n, i) => pos.set(n.id, { x: startX + i * (W + GX), y: cursorY + r * (H + ROW_GAP) }));
    });
    cursorY += rows.length * H + (rows.length - 1) * ROW_GAP + GY;
  }
  const height = cursorY - GY + PAD;
  return { pos, width, height, W, H };
}

let graphView = { scale: 1, dx: 0, dy: 0, touched: false };
let suppressNodeClick = false;

function applyGraphView() {
  const svg = $('#graph');
  const box = $('#graph-scroll');
  if (!svg || !box) return;
  const width = Number(svg.getAttribute('width')) || 0;
  const height = Number(svg.getAttribute('height')) || 0;
  const visualW = width * graphView.scale;
  const visualH = height * graphView.scale;
  // SVG 元素没有 offsetLeft，按 flex 居中规则反推未变换时的位置。
  const baseLeft = (box.clientWidth - width) / 2;
  const baseTop = 0;
  const minDx = Math.min(0, box.clientWidth - visualW) - baseLeft;
  const maxDx = Math.max(0, box.clientWidth - visualW) - baseLeft;
  const minDy = Math.min(0, box.clientHeight - visualH) - baseTop;
  const maxDy = Math.max(0, box.clientHeight - visualH) - baseTop;
  graphView.dx = Math.min(maxDx, Math.max(minDx, graphView.dx));
  graphView.dy = Math.min(maxDy, Math.max(minDy, graphView.dy));
  svg.style.transformOrigin = '0 0';
  svg.style.transform = `translate(${graphView.dx}px, ${graphView.dy}px) scale(${graphView.scale})`;
}

function fitGraph() {
  const svg = $('#graph');
  const box = $('#graph-scroll');
  if (!svg || !box) return;
  const width = Number(svg.getAttribute('width')) || 0;
  const height = Number(svg.getAttribute('height')) || 0;
  if (!width || !height) return;
  const pad = 18;
  graphView.scale = Math.max(0.1, Math.min((box.clientWidth - pad * 2) / width, (box.clientHeight - pad * 2) / height, 1));
  graphView.dx = (box.clientWidth - width * graphView.scale) / 2 - (box.clientWidth - width) / 2;
  graphView.dy = (box.clientHeight - height * graphView.scale) / 2;
  graphView.touched = true;
  applyGraphView();
}

function initGraphPan() {
  const box = $('#graph-scroll');
  const svg = $('#graph');
  if (!box || !svg) return;
  let down = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startDx = 0;
  let startDy = 0;
  let moved = 0;
  const onMove = (e) => {
    if (!down) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    moved = Math.hypot(mx, my);
    if (!dragging && moved < 4) return;
    dragging = true;
    box.classList.add('dragging');
    graphView.touched = true;
    graphView.dx = startDx + mx;
    graphView.dy = startDy + my;
    applyGraphView();
  };
  const end = () => {
    if (!down) return;
    down = false;
    if (dragging) {
      box.classList.remove('dragging');
      if (moved > 8) {
        suppressNodeClick = true;
        setTimeout(() => { suppressNodeClick = false; }, 0);
      }
    }
  };
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = true;
    dragging = false;
    moved = 0;
    startX = e.clientX;
    startY = e.clientY;
    startDx = graphView.dx;
    startDy = graphView.dy;
  });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  // 单击节点打开完整简报（事件委托，重渲染后依然有效）。
  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.node-box');
    if (!g || suppressNodeClick) return;
    const n = facts.nodes.find((x) => x.id === g.dataset.id);
    if (!n) return;
    hidePeek();
    openAgentModal(n.id);
  });
  // 展开态：滚轮以鼠标为中心缩放。
  box.addEventListener('wheel', (e) => {
    if (!document.querySelector('.graph-card.expanded')) return;
    e.preventDefault();
    e.stopPropagation();
    const svg = $('#graph');
    const rect = box.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const width = Number(svg.getAttribute('width')) || 1;
    const height = Number(svg.getAttribute('height')) || 1;
    const baseLeft = (box.clientWidth - width) / 2;
    const px = (cx - baseLeft - graphView.dx) / graphView.scale;
    const py = (cy - graphView.dy) / graphView.scale;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const next = Math.min(4, Math.max(0.1, graphView.scale * factor));
    graphView.scale = next;
    graphView.dx = cx - baseLeft - px * next;
    graphView.dy = cy - py * next;
    applyGraphView();
  }, { passive: false });
  $('#graph-fit')?.addEventListener('click', fitGraph);
  $('#graph-expand')?.addEventListener('click', () => {
    const card = document.querySelector('.graph-card');
    if (!card) return;
    const expanded = card.classList.toggle('expanded');
    $('#graph-expand').textContent = expanded ? '收起' : '展开';
    renderGraph();
    if (expanded) fitGraph();
  });
  window.addEventListener('resize', () => applyGraphView());
}

function renderGraph() {
  const svg = $('#graph');
  svg.innerHTML = '';
  const nodes = facts.nodes.filter((n) => ownerMatch(n.owner));
  const visible = new Set(nodes.map((n) => n.id));
  const box = $('#graph-scroll');
  const { pos, width, height, W, H } = layout(nodes, box ? box.clientWidth : 960);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.width = `${width}px`;
  svg.style.height = `${height}px`;
  const overflow = box && (width > box.clientWidth + 2 || height > box.clientHeight + 2);
  graphView = { scale: 1, dx: 0, dy: 0, touched: graphView.touched };
  if (overflow && !graphView.touched) fitGraph();
  else applyGraphView();

  const defs = sel('defs', {});
  const marker = sel('marker', {
    id: 'arrow', viewBox: '0 0 8 8', refX: 7, refY: 4,
    markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
  });
  marker.append(sel('path', { d: 'M0,0 L8,4 L0,8 z', fill: '#30363d' }));
  defs.append(marker);
  svg.append(defs);

  const cpEdges = new Set();
  const cpPath = facts.criticalPath.path;
  for (let i = 0; i < cpPath.length - 1; i++) cpEdges.add(`${cpPath[i]}>${cpPath[i + 1]}`);

  const edgeLayer = sel('g', {});
  svg.append(edgeLayer);
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!visible.has(d)) continue;
      const p = pos.get(d);
      const q = pos.get(n.id);
      if (!p || !q) continue;
      const x1 = p.x + W / 2, y1 = p.y + H;
      const x2 = q.x + W / 2, y2 = q.y;
      const dy = Math.max(18, (y2 - y1) / 2);
      const path = sel('path', {
        d: `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2 - 3}`,
        class: `edge${cpEdges.has(`${d}>${n.id}`) ? ' on-cp' : ''}`,
        'marker-end': 'url(#arrow)',
      });
      path.dataset.from = d;
      path.dataset.to = n.id;
      edgeLayer.append(path);
    }
  }

  const nodeLayer = sel('g', {});
  svg.append(nodeLayer);
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const g = sel('g', { class: 'node-box', transform: `translate(${p.x},${p.y})` });
    g.dataset.id = n.id;
    const lift = sel('g', { class: 'lift' });
    g.append(lift);
    lift.append(sel('rect', {
      width: W, height: H, rx: 6,
      fill: FILL[n.state], stroke: STROKE[n.state], 'stroke-width': 1.2,
    }));
    if (n.onCriticalPath) {
      lift.append(sel('line', {
        x1: 3, y1: 7, x2: 3, y2: H - 7,
        stroke: '#d29922', 'stroke-width': 3, 'stroke-linecap': 'round',
      }));
    }
    if (IDENTITY?.memberId && n.owner === IDENTITY.memberId) {
      lift.append(sel('circle', { cx: W - 8, cy: 9, r: 2.4, fill: '#58a6ff' }));
    }
    const l1 = sel('text', { x: 12, y: 19, 'font-size': 11, fill: '#7d8590', 'font-family': 'ui-monospace, Consolas, monospace' });
    l1.textContent = `${n.id} · ${n.owner} · ${LABEL[n.state]}`;
    const l2 = sel('text', { x: 12, y: 37, 'font-size': 12.5, fill: TEXT2 });
    l2.textContent = truncate(n.title, 11);
    lift.append(l1, l2);

    g.addEventListener('mouseenter', () => {
      svg.querySelectorAll('.edge').forEach((e) => {
        e.classList.toggle('dim', e.dataset.from !== n.id && e.dataset.to !== n.id);
      });
      g.classList.add('hot');
      showPeek(n, g);
    });
    g.addEventListener('mouseleave', () => {
      svg.querySelectorAll('.edge').forEach((e) => e.classList.remove('dim'));
      g.classList.remove('hot');
      hidePeek();
    });
    nodeLayer.append(g);
  }
}

function showPeek(n, g) {
  const box = $('#node-peek');
  box.innerHTML = '';
  const head = el('div', 'pk-head');
  head.append(el('span', 'pk-id', n.id), stateChip(n.state));
  if (n.onCriticalPath) head.append(el('span', 'pk-cp', '关键路径'));
  box.append(head);
  box.append(el('div', 'pk-title', n.title));
  const days = n.daysIdle === null || n.daysIdle === undefined ? '—' : `${n.daysIdle} 天`;
  box.append(el('div', 'pk-meta', `${n.ownerName || n.owner} · 工期 ${n.est}（约 ${n.days} 天） · 空闲 ${days} · 下游 ${n.downstream}`));
  box.append(el('div', 'pk-accept', `验收：${n.acceptance || '—'}`));
  const ev = [
    n.prs.length ? `PR ${n.prs.map((p) => `#${p.number}`).join(' ')}` : '',
    n.issues.length ? `issue ${n.issues.map((i) => `#${i.number}`).join(' ')}` : '',
    n.branch ? `分支 ${n.branch}` : '',
    n.commits.length ? `提交 ${n.commits.length}` : '',
  ].filter(Boolean);
  box.append(el('div', 'pk-ev', `证据：${ev.join(' · ') || '暂无'}`));
  box.append(el('div', 'pk-hint', '单击节点打开完整简报'));
  box.hidden = false;
  const r = g.getBoundingClientRect();
  const gap = 12;
  const w = box.offsetWidth || 268;
  const h = box.offsetHeight || 140;
  let x = r.right + gap;
  if (x + w > window.innerWidth - 8) x = r.left - w - gap;
  if (x < 8) x = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let y = r.top;
  if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
  if (y < 8) y = 8;
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
}

function hidePeek() {
  $('#node-peek').hidden = true;
}

function stateChip(st) {
  return el('span', `state ${st}`, LABEL[st]);
}
