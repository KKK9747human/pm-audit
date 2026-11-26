const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const sel = (tag, attrs) => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

// 卡片内容放不下时用「上一页/下一页」翻页，不用滚轮。
function pager(items, pageSize, renderItem, bodyTag = 'div') {
  let page = 0;
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const body = bodyTag === 'div' ? el('div', 'list') : el(bodyTag);
  const info = el('span', 'pager-info', '');
  const prev = el('button', 'mini', '上一页');
  const next = el('button', 'mini', '下一页');
  const foot = el('div', 'pager');
  foot.append(prev, info, next);
  const render = () => {
    body.innerHTML = '';
    for (const item of items.slice(page * pageSize, (page + 1) * pageSize)) renderItem(body, item);
    info.textContent = `${page + 1} / ${pages}`;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
    foot.style.display = pages > 1 ? '' : 'none';
  };
  prev.onclick = () => { if (page > 0) { page -= 1; render(); } };
  next.onclick = () => { if (page < pages - 1) { page += 1; render(); } };
  render();
  return { body, foot };
}

const LABEL = { done: '完成', active: '进行中', stale: '停滞', blocked: '被阻塞', ready: '待启动' };
const FILL = { done: 'rgba(63,185,80,.18)', active: 'rgba(88,166,255,.18)', stale: 'rgba(210,153,34,.18)', blocked: 'rgba(248,81,73,.18)', ready: 'rgba(110,118,129,.18)' };
const STROKE = { done: '#3fb950', active: '#58a6ff', stale: '#d29922', blocked: '#f85149', ready: '#6e7681' };
const TEXT2 = '#e6edf3';

let projects = [];
let PROJECT = null;
let IDENTITY = null;
let facts = null;
let currentId = null;
let currentHash = null;
let PUBLISHED = null;
let ROLE = { isAdmin: false, admin: null };
let AGENT = null;
let TRAIL = null;
let ALERTS = null;
let NEXT_ACTIONS = null;
let BRIEF_HISTORY = [];
let projectGeneration = 0;
let projectLoading = false;
let projectBusy = false;
let autoSyncRunning = false;
let autoSyncReloadPending = false;
let autoSyncRequest = 0;
let projectsRequest = 0;
let alertsRequest = 0;
let trailRequest = 0;
let agentRequest = 0;
let modalGeneration = 0;
let drawerGeneration = 0;
const projectContext = () => ({ id: currentId, generation: projectGeneration, hash: currentHash });
const isCurrent = (ctx) => ctx.id === currentId && ctx.generation === projectGeneration && ctx.hash === currentHash;
const staleRequest = () => Object.assign(new Error('请求已过期'), { code: 'STALE_REQUEST' });

function withActionTimeout(promise, action, ms = 120000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${action}超时，服务端可能仍在处理；请稍后再试`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function updateProjectActions() {
  const ready = Boolean(PROJECT && !projectLoading);
  const available = ready && !projectBusy;
  const set = (selector, enabled, text) => {
    const b = $(selector);
    if (!b) return;
    b.disabled = !enabled;
    if (text != null) b.textContent = text;
  };
  set('#who', ready);
  set('#btn-sync', available, projectBusy ? '处理中…' : '同步');
  set('#refresh', available, projectBusy ? '处理中…' : '刷新数据');
  set('#btn-publish', available && facts && ROLE.isAdmin, '写回');
  set('#btn-prnote', available && facts && ROLE.isAdmin);
  set('#btn-auto', ready);
  set('#export', ready && facts);
  set('#btn-agent', ready && facts);
  set('#btn-trail-md', ready && TRAIL && isCurrent(TRAIL) && TRAIL.data?.markdown);
  set('#send', ready && facts && !streaming);
  set('#q', ready && facts);
  document.querySelectorAll('#welcome button[data-project-action]').forEach((b) => {
    b.disabled = !available || (b.dataset.projectAction === 'pull' && !ROLE.isAdmin);
  });
}

function beginProjectAction(ctx) {
  if (!isCurrent(ctx) || !PROJECT || projectLoading || projectBusy) return false;
  projectBusy = true;
  updateProjectActions();
  return true;
}

function finishProjectAction(ctx) {
  if (ctx.id !== currentId || ctx.generation !== projectGeneration) return;
  projectBusy = false;
  updateProjectActions();
  if (autoSyncReloadPending) {
    autoSyncReloadPending = false;
    autoSync(ctx.id);
  }
}

async function reloadProject(ctx) {
  await loadProjects(() => isCurrent(ctx));
  if (!isCurrent(ctx)) return false;
  return openProject(ctx.id, { sync: false });
}

let settings = { hasKey: false, hint: '', provider: 'longcat', baseUrl: 'https://api.longcat.chat/openai/v1', model: 'LongCat-2.5', providers: [] };
let filter = 'all';
let streaming = false;
let chatMode = localStorage.getItem('pm.chatMode') === 'advanced' ? 'advanced' : 'beginner';
const chats = new Map();

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
const BASE_MARK = /<!--\s*pm:base=([A-Za-z0-9:._-]+)\s*-->/i;
const prBaseOf = (pr) => {
  if (pr?.pm_base) return pr.pm_base;
  const m = BASE_MARK.exec(pr?.body || '');
  return m ? m[1] : null;
};
function baseState(pr, current, history = BRIEF_HISTORY) {
  const declared = prBaseOf(pr);
  if (!declared) return 'none';
  const d = String(declared).replace(/^sha256:/i, '').toLowerCase();
  if (!/^[0-9a-f]{8,}$/.test(d)) return 'bad';
  const c = String(current || '').replace(/^sha256:/i, '').toLowerCase();
  if (c && c.startsWith(d)) return 'ok';
  const norm = (v) => String(v || '').replace(/^sha256:/i, '').toLowerCase();
  const entry = history.find((h) => norm(h.hash).startsWith(d));
  if (!entry) return 'unknown';
  // 判定看 PR 创建时：声明的那版之后、PR 创建之前是否已有更新的简报。
  // 不能用「当前简报」直接比，否则 PM 自己刷新一次、甚至这条 PR 本身成为证据，
  // 都会把刚开的 PR 误标成旧简报。
  const created = Date.parse(pr?.created_at || '');
  if (!Number.isFinite(created)) return 'unknown';
  const declaredAt = Date.parse(entry.asOf || '');
  const newer = history.some((h) => {
    const t = Date.parse(h.asOf || '');
    return Number.isFinite(t) && t > declaredAt && t <= created;
  });
  return newer ? 'old' : 'ok';
}
const shortBase = (v) => String(v || '').replace(/^sha256:/i, '').slice(0, 8);
const mdLite = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, (_, code) => `<pre>${code.trim()}</pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '• $1')
    .replace(/\n/g, '<br>');
const fmtDay = (v) => (v ? new Date(v).toLocaleDateString('zh-CN') : '—');
const fmtTime = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');
const daysSince = (v) => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
};

/* ---------- 侧栏 / 项目 ---------- */

async function loadProjects(valid = () => true) {
  const request = ++projectsRequest;
  const res = await fetch('/api/projects?t=' + Date.now());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!valid() || request !== projectsRequest) return false;
  projects = data;
  renderSidebar();
  return true;
}

function renderSidebar() {
  const box = $('#projects');
  box.innerHTML = '';
  if (!projects.length) {
    box.append(el('p', 'sub', '还没有项目。导入数据包或新建。'));
    return;
  }
  for (const p of projects) {
    const b = el('button', 'proj' + (p.id === currentId ? ' on' : ''));
    const pn = el('div', 'pn');
    pn.append(el('span', '', p.name), el('em', '', p.stats ? `${p.stats.nodes} 节点` : '未审计'));
    b.append(pn, el('div', 'pr', p.repo));
    if (p.stats) {
      const s = p.stats;
      const total = Math.max(1, s.nodes || 0);
      const bar = el('div', 'pbar');
      for (const [k, n, label] of [['done', s.done, '完成'], ['active', s.active, '进行中'], ['stale', s.stale, '停滞'], ['blocked', s.blocked, '被阻塞'], ['ready', s.ready, '待启动']]) {
        if (!n) continue;
        const seg = el('i', k);
        seg.style.width = `${(n / total) * 100}%`;
        seg.title = `${label} ${n}`;
        bar.append(seg);
      }
      b.append(bar);
    }
    b.onclick = () => openProject(p.id);
    box.append(b);
  }
}


async function openProject(id, { sync = true, navigate = false } = {}) {
  ++projectGeneration;
  ++autoSyncRequest;
  autoSyncRunning = false;
  autoSyncReloadPending = false;
  closeDrawer();
  closeModal();
  const prevId = currentId;
  currentId = id;
  graphView.touched = false;
  currentHash = null;
  facts = null;
  PROJECT = null;
  IDENTITY = null;
  ROLE = { isAdmin: false, admin: null };
  PUBLISHED = AGENT = TRAIL = ALERTS = NEXT_ACTIONS = null;
  BRIEF_HISTORY = [];
  filter = 'all';
  projectLoading = true;
  projectBusy = false;
  streaming = false;
  const ctx = projectContext();
  localStorage.setItem('pm.current', id);
  renderSidebar();
  hidePeek();
  for (const selector of ['#stats', '#next-actions', '#graph', '#critical', '#blockers', '#people', '#trail', '#chat', '#prompts', '#alerts-count', '#trail-verify', '#hash', '#who', '#role', '#fetched']) {
    $(selector).replaceChildren();
    $(selector).title = '';
  }
  $('#q').value = '';
  $('#dashboard').hidden = true;
  $('#welcome').hidden = false;
  $('#welcome').replaceChildren(el('h2', '', '正在加载项目…'), el('p', '', '请稍候，加载完成前不能操作项目数据。'));
  $('#pname').textContent = projects.find((p) => p.id === id)?.name || id;
  $('#repo').textContent = '';
  $('#main').setAttribute('aria-busy', 'true');
  document.title = '正在加载 · PM 审计台';
  updateProjectActions();
  try {
    const res = await fetch(`/api/projects/${id}?t=` + Date.now());
    if (!isCurrent(ctx)) return false;
    if (res.status === 404) {
      PROJECT = projects.find((p) => p.id === id) || { id, name: id, repo: '' };
      IDENTITY = PROJECT.identity || null;
      ROLE = { isAdmin: Boolean(PROJECT.isAdmin), admin: PROJECT.admin || null };
      projectLoading = false;
      $('#main').setAttribute('aria-busy', 'false');
      showWelcome(PROJECT);
      return true;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const bundle = await res.json();
    if (!isCurrent(ctx)) return false;
    PROJECT = bundle.project;
    facts = bundle.facts;
    IDENTITY = bundle.identity || null;
    ROLE = { isAdmin: Boolean(bundle.isAdmin), admin: bundle.admin || null };
    PUBLISHED = bundle.published || null;
    BRIEF_HISTORY = Array.isArray(bundle.briefHistory) ? bundle.briefHistory : [];
    currentHash = bundle.hashes?.facts || null;
    projectLoading = false;
    $('#main').setAttribute('aria-busy', 'false');
    renderAll();
    if (prevId !== id || navigate) goPage(0);
    else goPage(page);
    if (sync) autoSync(id);
    return true;
  } catch (err) {
    if (ctx.id !== currentId || ctx.generation !== projectGeneration) return false;
    projectLoading = false;
    PROJECT = null;
    facts = null;
    $('#main').setAttribute('aria-busy', 'false');
    $('#dashboard').hidden = true;
    $('#welcome').hidden = false;
    const retry = el('button', 'btn', '重试加载');
    retry.onclick = () => openProject(id);
    $('#welcome').replaceChildren(el('h2', '', '加载项目失败'), el('p', '', err.message), retry);
    updateProjectActions();
    toast('加载项目失败：' + err.message);
    return false;
  }
}

async function autoSync(id) {
  const ctx = projectContext();
  if (id !== ctx.id || !PROJECT || projectLoading || autoSyncRunning) return;
  const request = ++autoSyncRequest;
  autoSyncRunning = true;
  let ownsAction = false;
  try {
    const res = await withActionTimeout(fetch(`/api/projects/${id}/sync`, { method: 'POST' }), '同步');
    if (!res.ok) return;
    const j = await res.json();
    if (!isCurrent(ctx) || request !== autoSyncRequest) return;
    if (j.status === 'updated') {
      toast(`已读取仓库里的 PM 数据包 ${String(j.hash).slice(7, 15)}`);
      if (projectBusy || streaming) {
        autoSyncReloadPending = true;
        return;
      }
      if (!beginProjectAction(ctx)) return;
      ownsAction = true;
      await reloadProject(ctx);
    } else if (j.status === 'invalid') {
      toast('仓库里的 PM 数据包校验失败，已忽略');
    } else if (j.status === 'untrusted') {
      toast(`拒绝加载：远端数据包作者 ${j.author || '未知'} 不是管理员 ${j.expectedAdmin}`);
    }
  } catch {} finally {
    if (ownsAction) finishProjectAction(ctx);
    if (request === autoSyncRequest) autoSyncRunning = false;
  }
}

async function syncNow() {
  const ctx = projectContext();
  if (!beginProjectAction(ctx)) return;
  try {
    const res = await withActionTimeout(fetch(`/api/projects/${ctx.id}/sync?force=1`, { method: 'POST' }), '同步');
    const j = await res.json();
    if (!isCurrent(ctx)) return;
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    if (j.status === 'updated') {
      toast(`已读取仓库里的 PM 数据包 ${String(j.hash).slice(7, 15)}`);
      await reloadProject(ctx);
    } else if (j.status === 'same') {
      toast('远端已是最新，没有更新');
    } else if (j.status === 'absent') {
      toast('仓库里还没有 PM 数据包，请由管理员发布第一份或导入数据包');
    } else if (j.status === 'untrusted') {
      toast(`拒绝加载：远端数据包作者 ${j.author || '未知'} 不是管理员 ${j.expectedAdmin}`);
    } else {
      toast('远端数据包校验失败，已忽略');
    }
  } catch (err) {
    if (isCurrent(ctx)) toast('同步失败：' + err.message);
  } finally {
    finishProjectAction(ctx);
  }
}

async function publishNow() {
  if (!currentId || !facts || projectLoading) return;
  if (!ROLE.isAdmin) {
    toast(`只读模式：项目进度数据由管理员（${ROLE.admin || '未设置'}）维护`);
    return;
  }
  const ctx = projectContext();
  if (!beginProjectAction(ctx)) return;
  try {
    const res = await withActionTimeout(fetch(`/api/projects/${ctx.id}/publish`, { method: 'POST' }), '写回', 180000);
    const j = await res.json();
    if (!isCurrent(ctx)) return;
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    if (j.status === 'published') {
      PUBLISHED = { hash: j.hash, commit: j.commit, updatedAt: new Date().toISOString() };
      $('#hash').title = `${ctx.hash} · 仓库已写回 ${String(j.commit).slice(0, 8)}`;
      toast(`已写回 ${j.changed} 个文件 · commit ${String(j.commit).slice(0, 8)}`);
      if (j.hash !== ctx.hash) await reloadProject(ctx);
    } else {
      toast('远端已经是最新，无需写回');
    }
  } catch (err) {
    if (isCurrent(ctx)) toast('写回失败：' + err.message);
  } finally {
    finishProjectAction(ctx);
  }
}

/* ---------- 分页 ---------- */

const PAGE_COUNT = 4;
let page = 0;

function goPage(n) {
  page = Math.max(0, Math.min(PAGE_COUNT - 1, n));
  hidePeek();
  const track = $('#pages');
  if (track) track.style.transform = `translateY(-${page * 100}%)`;
  document.querySelectorAll('#page-tabs button').forEach((b) => {
    const active = Number(b.dataset.page) === page;
    b.classList.toggle('on', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('#pages > .page').forEach((section, i) => {
    section.inert = i !== page;
    section.setAttribute('aria-hidden', String(i !== page));
  });
  if (page === 3) renderChat(currentId);
}

function initPager() {
  const dash = $('#dashboard');
  const nav = $('#page-tabs');
  if (!dash || !nav) return;
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) goPage(Number(b.dataset.page));
  });
  document.addEventListener('keydown', (e) => {
    if (dash.hidden) return;
    if (!$('#modal-mask').hidden || !$('#drawer').hidden) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (window.matchMedia('(max-width: 900px)').matches && !document.activeElement?.closest('#page-tabs')) return;
    if (e.key === 'PageDown' || e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      goPage(page + 1);
    } else if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      goPage(page - 1);
    }
  });
}

/* ---------- 主界面 ---------- */

function renderAll() {
  $('#welcome').hidden = true;
  $('#dashboard').hidden = false;  $('#pname').textContent = PROJECT.name;
  $('#repo').textContent = PROJECT.repo;
  $('#fetched').textContent = `数据基准 ${fmtTime(facts.asOf)}`;
  const h = $('#hash');
  h.textContent = currentHash ? `指纹 ${currentHash.slice(7, 15)}` : '';
  h.title = [
    currentHash || '数据包指纹',
    PUBLISHED?.commit ? `仓库已写回 ${String(PUBLISHED.commit).slice(0, 8)}` : '尚未写回仓库',
  ].join(' · ');
  renderWho();
  renderRole();
  renderMode();
  renderStats();
  renderNextActions();
  renderNotice();
  renderFilters();
  renderLegend();
  renderGraph();
  renderCritical();
  renderBlockers();
  renderPeople();
  renderTrailPage();
  renderChat(currentId);
  renderPrompts();
  document.title = `${PROJECT.name} · PM 审计台`;
  updateProjectActions();
}

function renderWho() {
  const w = $('#who');
  w.className = 'who';
  w.style.cursor = 'pointer';
  w.onclick = openIdentity;
  if (!IDENTITY || (!IDENTITY.login && !IDENTITY.email)) {
    w.textContent = '身份未识别 · 点我设置';
    w.className = 'who none';
    w.title = '检测不到 gh 登录或 git 邮箱，点此填写';
    return;
  }
  const who = IDENTITY.login || IDENTITY.email;
  if (IDENTITY.memberId) {
    w.textContent = `${who} · ${IDENTITY.memberId}`;
    w.title = `本机身份 → 成员 ${IDENTITY.memberId}（${IDENTITY.memberName || ''}）｜ 点击更换映射`;
  } else {
    w.textContent = `${who} · 未匹配成员`;
    w.className = 'who none';
    w.title = '本机身份没有匹配到项目 members[].github，点击绑定';
  }
}

function renderRole() {
  const c = $('#role');
  if (!c) return;
  const canWrite = ROLE.isAdmin;
  c.textContent = ROLE.admin ? (canWrite ? '管理员' : '只读') : '未设管理员';
  c.className = 'chip ' + (canWrite ? 'admin' : 'readonly');
  c.title = canWrite
    ? `本机是管理员（${ROLE.admin}），可写回数据包`
    : ROLE.admin
      ? `只读：项目进度数据由管理员 ${ROLE.admin} 维护，本机只能同步读取`
      : '只读：projects/<id>/project.json 未配置 admin，写回已锁';
  const pub = $('#btn-publish');
  if (pub) {
    pub.disabled = !canWrite;
    pub.title = canWrite
      ? '把当前数据包与 Agent 简报写回仓库 .pm/'
      : `只读：只有管理员（${ROLE.admin || '未设置'}）可以写回`;
  }
  const pn = $('#btn-prnote');
  if (pn) {
    pn.disabled = !canWrite;
    pn.title = canWrite ? '把当前进度摘要评论到指定 PR' : '只读：只有管理员可以往仓库发 PM 备注';
  }
  const auto = $('#btn-auto');
  if (auto) {
    auto.title = canWrite ? '每隔 10 分钟检查远端，有变化才刷新并写回' : '每隔 10 分钟从仓库同步（只读）';
  }
  updateProjectActions();
}

function openPrNote() {
  if (!PROJECT || !currentId) return;
  if (!ROLE.isAdmin) {
    toast(`只读模式：PR 备注由管理员（${ROLE.admin || '未设置'}）发布`);
    return;
  }
  const ctx = projectContext();
  openModal('发 PR 备注', '把当前审计摘要（节点统计、关键路径、卡点）评论到指定 PR，带 PM 标识；同一指纹重复发会更新原评论。', (m) => {
    const token = modalGeneration;
    const active = () => isCurrent(ctx) && token === modalGeneration;
    const pr = inputEl('text', '例如 2');
    field(m, 'PR 编号', pr, '只写评论，不改代码。');
    const msg = el('div');
    m.append(msg);
    actionsEl(m, [
      ['关闭', '', closeModal],
      ['发送', 'primary', async (e) => {
        if (!active() || !ROLE.isAdmin) return;
        const n = Number(pr.value.trim());
        if (!n) { msg.append(el('div', 'errbox', '先填 PR 编号')); return; }
        const btn = e.target;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/projects/${ctx.id}/pr-note`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pr: n }),
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          msg.innerHTML = '';
          if (active()) msg.append(el('div', 'okbox', j.status === 'updated' ? `已更新 PR #${n} 的 PM 备注` : `已评论 PR #${n}`));
        } catch (err) {
          if (active()) msg.replaceChildren(el('div', 'errbox', String(err.message)));
        } finally {
          if (active()) btn.disabled = !ROLE.isAdmin;
        }
      }],
    ]);
  });
}

function openLinker(branch) {
  if (!PROJECT) return;
  const ctx = projectContext();
  const nodes = facts?.nodes || [];
  openModal(`归位：${branch}`, '选一个节点，PM 会在该分支的 open PR 上留一条关联证据；没有 open PR 时给出可照抄的命令。', (m) => {
    const token = modalGeneration;
    const active = () => isCurrent(ctx) && token === modalGeneration;
    let request = 0;
    const hint = el('p', 'sub');
    m.append(hint);
    const list = el('div', 'list');
    for (const n of nodes) {
      const row = el('div', 'row');
      row.append(el('span', 'id', n.id), el('span', 't', n.title));
      row.append(el('span', 'tag', n.owner));
      const btn = el('button', 'mini', '选这个');
      btn.onclick = () => {
        const selected = ++request;
        linkBranch(branch, n.id, hint, ctx, () => active() && selected === request);
      };
      row.append(btn);
      list.append(row);
    }
    m.append(list);
    actionsEl(m, [['关闭', '', closeModal]]);
  });
}

async function linkBranch(branch, node, hint, ctx, active) {
  if (!active()) return;
  try {
    const res = await fetch(`/api/projects/${ctx.id}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, node }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    if (!active()) return;
    if (j.status === 'no-pr') {
      hint.textContent = `分支 ${branch} 没有 open PR，无法自动归位。可以等 PR 开了再说，或在合并前把 [${node}] 写进提交/PR 标题。`;
      return;
    }
    const cmd = j.command || '';
    hint.innerHTML = '';
    hint.append(el('div', 'okbox', `将评论 PR #${j.pr}：\`<!-- pm:node=${node} -->\``));
    const pre = el('div', 'agent-pre', cmd);
    hint.append(pre);
    const row = el('div', 'agent-actions');
    const copy = el('button', 'btn ghost', '复制命令');
    copy.onclick = () => { navigator.clipboard.writeText(cmd); toast('已复制归位命令'); };
    row.append(copy);
    if (!ROLE.isAdmin) {
      row.append(el('span', 'muted', `只读：把这条命令交给管理员 ${ROLE.admin || '（未设置）'} 执行`));
    } else {
      const run = el('button', 'btn primary', '直接执行');
      run.onclick = async () => {
        if (!active() || !ROLE.isAdmin) return;
        run.disabled = true;
        try {
          const r2 = await fetch(`/api/projects/${ctx.id}/link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branch, node, run: true }),
          });
          const j2 = await r2.json();
          if (!active()) return;
          if (!r2.ok) throw new Error(j2.error || `HTTP ${r2.status}`);
          toast(`已归位到 PR #${j2.pr}（节点 ${node}）`);
          closeModal();
        } catch (err) {
          if (active()) toast('归位失败：' + err.message);
        } finally {
          if (active()) run.disabled = !ROLE.isAdmin;
        }
      };
      row.append(run);
    }
    hint.append(row);
  } catch (err) {
    if (active()) hint.textContent = '归位失败：' + err.message;
  }
}

function openIdentity() {
  if (!PROJECT || projectLoading) return;
  const ctx = projectContext();
  const members = projects.find((p) => p.id === ctx.id)?.members || PROJECT.members || {};
  const identity = IDENTITY;
  openModal('本机身份', 'PM 靠 gh 登录名和 git 邮箱认人。请明确选择已有成员，再保存账号映射；此处不新增成员或管理员。', (m) => {
    const token = modalGeneration;
    const active = () => isCurrent(ctx) && token === modalGeneration;
    const id = identity?.login || identity?.email || '（没读到）';
    m.append(el('p', 'agent-identity', `当前识别：${id}${identity?.memberId ? ` → ${identity.memberId}` : ''}`));
    if (!Object.keys(members).length) {
      m.append(el('div', 'errbox', '当前没有可绑定的成员，不能保存身份映射。'));
      m.append(el('p', 'tip', `请让项目维护者核对本机 projects/${ctx.id}/project.json 的 members，按真实分工配置成员及 github 登录名后重新加载；也可导入含成员信息的有效 v2 数据包。不要通过随意添加成员或管理员来绕过权限。`));
      actionsEl(m, [
        ['关闭', '', closeModal],
        ['导入数据包', '', openImport],
        ['重新加载项目', 'primary', () => { if (active()) openProject(ctx.id, { sync: false }); }],
      ]);
      return;
    }
    const member = el('select');
    const placeholder = el('option', '', '请选择要绑定的成员');
    placeholder.value = '';
    member.append(placeholder);
    for (const [mid, mem] of Object.entries(members)) {
      const option = el('option', '', `${mid} · ${mem.name || ''} · GitHub: ${mem.github || '未填'}`);
      option.value = mid;
      member.append(option);
    }
    member.value = '';
    field(m, '要绑定的已有成员', member);
    const gh = inputEl('text', 'GitHub 登录名', identity?.login || '');
    field(m, '这个成员的 GitHub 登录名', gh, '仅保存所选成员的账号映射。请核对账号归属，现有权限规则可能据此识别可写成员。');
    const msg = el('div');
    m.append(msg);
    const actions = actionsEl(m, [
      ['关闭', '', closeModal],
      ['保存并重新识别', 'primary', async (e) => {
        const memberId = member.value;
        const github = gh.value.trim();
        if (!active() || !Object.hasOwn(members, memberId) || !github) return;
        const btn = e.currentTarget || e.target;
        btn.disabled = true;
        member.disabled = gh.disabled = true;
        try {
          const res = await fetch(`/api/projects/${ctx.id}/identity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberId, github }),
          });
          const j = await res.json();
          if (!active()) return;
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          await loadProjects(active);
          if (!active()) return;
          toast(`已绑定：${j.label}`);
          closeModal();
          await openProject(ctx.id, { sync: false });
        } catch (err) {
          if (active()) msg.replaceChildren(el('div', 'errbox', '绑定失败：' + err.message));
        } finally {
          if (active()) {
            member.disabled = gh.disabled = false;
            btn.disabled = !member.value || !gh.value.trim();
          }
        }
      }],
    ]);
    const save = actions.querySelector('.primary');
    const validate = () => { save.disabled = !member.value || !gh.value.trim(); };
    member.onchange = validate;
    gh.oninput = validate;
    validate();
  });
}

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

/* ---------- 节点抽屉 ---------- */

/* ---------- 证据链 ---------- */

async function renderTrailPage() {
  const box = $('#trail');
  if (!box || !facts || !currentId) return;
  if (TRAIL && isCurrent(TRAIL)) {
    paintTrail(TRAIL.data);
    return;
  }
  const ctx = projectContext();
  const request = ++trailRequest;
  const active = () => isCurrent(ctx) && request === trailRequest;
  box.innerHTML = '';
  box.append(el('p', 'sub', '正在重算指纹并生成证据链…'));
  try {
    const res = await fetch(`/api/projects/${ctx.id}/trail?t=` + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!active()) return;
    TRAIL = { ...ctx, data };
    paintTrail(data);
    updateProjectActions();
  } catch (err) {
    if (!active()) return;
    box.innerHTML = '';
    box.append(el('p', 'sub', '证据链不可用：' + err.message));
    $('#trail-verify').textContent = '指纹校验未完成';
    $('#trail-verify').className = 'chip readonly';
  }
}

function paintTrail(data) {
  const chip = $('#trail-verify');
  const v = data.verify || {};
  const legacy = v.code === 'LEGACY_BUNDLE' || /LEGACY_BUNDLE|数据包版本.*已过期/i.test(v.error || '');
  const mismatch = !v.ok && !legacy && !v.error && Boolean(v.expected && v.actual);
  chip.textContent = v.ok ? '指纹自洽（非真实性认证）' : legacy ? '旧版数据包：需重新审计' : mismatch ? '指纹不一致' : '指纹校验未完成';
  chip.className = 'chip ' + (v.ok ? 'ok' : 'readonly');
  const explanation = v.ok
    ? '从包内计划与证据重算一致，仅说明指纹自洽，不证明证据真实、作者身份或业务验收通过。'
    : legacy
      ? '旧版数据包不能按当前规则验证，请由管理员重新审计并发布 v2 数据包；这不等于指纹不一致。'
      : mismatch
        ? '包内数据与重算结果不一致，本报告仅供排查。'
        : '校验发生错误或未返回完整结果，不能判定指纹是否一致。';
  chip.title = `${explanation}\n包内 ${v.expected || data.trail?.hash || '?'}\n重算 ${v.actual || '?'}${v.error ? '\n' + v.error : ''}`;
  const box = $('#trail');
  box.innerHTML = '';
  box.append(el('p', 'sub', explanation));
  const t = data.trail;
  const link = (text, href, cls) => {
    const a = el('a', cls || '', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  };
  const ciChip = (checks) => {
    if (!checks) return el('span', 'base-tag', 'CI 未采集');
    const cls = checks.status === 'passed' ? 'ok' : checks.status === 'failed' ? 'bad' : checks.status === 'pending' ? 'old' : '';
    const label = {
      passed: 'CI 已采集的全部成功',
      failed: 'CI 有失败',
      pending: 'CI 未完成',
      unknown: 'CI 未知',
    }[checks.status] || 'CI 未知';
    const suffix = checks.truncated ? '（列表可能截断）' : checks.complete ? '' : '（采集不完整）';
    const tag = el('span', `base-tag ${cls}`.trim(), label + suffix);
    tag.title = `${checks.reason || ''}${checks.headSha ? `\nhead ${String(checks.headSha).slice(0, 12)}` : ''}`;
    return tag;
  };
  const prRow = (p) => {
    const row = el('div', 'trail-pr');
    row.append(link(`PR #${p.number}`, p.url, 'mono'));
    row.append(el('span', '', p.merged_at ? `合并于 ${fmtDay(p.merged_at)}` : p.state === 'open' ? '开放中' : p.state));
    if (p.head_ref) row.append(el('span', 'mono dim', `${p.head_ref}${p.base_ref ? ` → ${p.base_ref}` : ''}`));
    if (p.additions != null) row.append(el('span', 'mono dim', `+${p.additions}/-${p.deletions} · ${p.changed_files} 文件`));
    row.append(ciChip(p.checks));
    const st = baseState(p, currentHash);
    if (st === 'old') {
      const tag = el('span', 'base-tag old', '基于旧简报');
      tag.title = `PR 声明基准 ${shortBase(prBaseOf(p))}，PR 创建前已有更新的简报`;
      row.append(tag);
    } else if (st === 'ok') {
      const tag = el('span', 'base-tag ok', `基准 ${shortBase(prBaseOf(p))}`);
      tag.title = 'PR 声明的简报基准有效';
      row.append(tag);
    }
    return row;
  };
  const nodeCard = (n) => {
    const card = el('div', `trail-node ${n.state}`);
    const top = el('div', 'trail-top');
    top.append(el('span', 'mono id', n.id), el('b', '', n.title));
    top.append(el('span', 'dim', `${n.owner}${n.ownerName ? ` · ${n.ownerName}` : ''}`));
    top.append(stateChip(n.state));
    card.append(top);
    card.append(el('div', 'trail-accept', `验收：${n.acceptance || '（计划里没写）'}`));
    for (const p of n.prs) card.append(prRow(p));
    for (const i of n.issues) {
      const row = el('div', 'trail-pr');
      row.append(link(`issue #${i.number}`, i.url, 'mono'), el('span', '', `${i.state} · ${i.title}`));
      card.append(row);
    }
    if (n.commits.length) {
      const ul = el('ul', 'trail-commits');
      for (const c of n.commits.slice(0, 8)) {
        const li = el('li');
        li.append(link(c.sha, c.url, 'mono'), document.createTextNode(` ${fmtDay(c.date)} ${c.message}`));
        ul.append(li);
      }
      card.append(ul);
    }
    if (n.note) card.append(el('p', 'sub', n.note));
    if (n.files.length) {
      const row = el('div', 'trail-files');
      row.append(el('span', 'dim', '证据文件：'));
      for (const f of n.files) row.append(link(f.path, f.url, 'mono'));
      card.append(row);
    }
    return card;
  };

  const done = t.nodes.filter((n) => n.state === 'done');
  box.append(el('h3', 'trail-head', `已完成（${done.length}）——开发闭环依据见各节点证据`));
  if (!done.length) box.append(el('p', 'sub', '还没有节点完成。'));
  else {
    const p = pager(done, 4, (list, n) => list.append(nodeCard(n)));
    box.append(p.body, p.foot);
  }

  const working = t.nodes.filter((n) => n.state === 'active' || n.state === 'stale');
  box.append(el('h3', 'trail-head', `进行中 / 停滞（${working.length}）`));
  if (!working.length) box.append(el('p', 'sub', '无。'));
  else {
    const p = pager(working, 4, (list, n) => list.append(nodeCard(n)));
    box.append(p.body, p.foot);
  }

  const rest = t.nodes.filter((n) => n.state === 'blocked' || n.state === 'ready');
  box.append(el('h3', 'trail-head', `待启动 / 被阻塞（${rest.length}）`));
  if (rest.length) {
    const table = el('table', 'trail-table');
    const thead = el('tr');
    for (const h of ['节点', '任务', '负责人', '状态', '在等', '下游']) thead.append(el('th', '', h));
    table.append(thead);
    for (const n of rest) {
      const tr = el('tr');
      tr.append(el('td', 'mono', n.id), el('td', '', n.title), el('td', '', n.owner));
      const tdState = el('td');
      tdState.append(stateChip(n.state));
      tr.append(tdState, el('td', 'mono', n.blockedBy.join('、') || '—'), el('td', '', String(n.downstream)));
      table.append(tr);
    }
    box.append(table);
  } else box.append(el('p', 'sub', '无。'));
}

async function openDrawer(n) {
  if (!facts || projectLoading) return;
  const ctx = projectContext();
  const token = ++drawerGeneration;
  const active = () => isCurrent(ctx) && token === drawerGeneration;
  const d = $('#drawer');
  d.innerHTML = '';
  d.hidden = false;
  $('#mask').hidden = false;

  const close = el('button', 'close', '×');
  close.onclick = closeDrawer;
  d.append(close);
  d.append(el('h3', '', `${n.id} ${n.title}`));
  const chips = el('div', 'agent-actions');
  chips.append(stateChip(n.state));
  if (n.done) {
    const via = n.prs.some((p) => p.merged_at) ? 'PR 已合并' : n.issues.some((i) => i.state === 'closed') ? 'Issue 已关闭' : '完成';
    const doneTag = el('span', 'base-tag ok', via);
    doneTag.title = '这是 GitHub 生命周期闭环，不等于业务验收已通过';
    chips.append(doneTag);
  }
  if (IDENTITY?.memberId && n.owner === IDENTITY.memberId) {
    const mine = el('span', 'state active', '我的节点');
    chips.prepend(mine);
  }
  d.append(chips);

  const askBtn = el('button', 'btn', '问 PM：这个节点下一步怎么做');
  askBtn.style.marginTop = '10px';
  askBtn.onclick = () => {
    closeDrawer();
    ask(`节点 ${n.id}（${n.title}）现在该怎么做？给出具体的下一步、要改的文件，以及需要先解除的依赖。`);
  };
  d.append(askBtn);

  const sec = (title, build) => {
    const s = el('div', 'sec');
    s.append(el('h4', '', title));
    build(s);
    d.append(s);
    return s;
  };
  const kv = (k, v) => {
    const r = el('div', 'kv');
    r.append(el('span', 'k', k), el('span', '', v));
    return r;
  };

  sec('基本信息', (s) => {
    s.append(kv('负责人', `${n.owner}（${PROJECT.members?.[n.owner]?.name || ''}）`));
    s.append(kv('工期', `${n.est}（约 ${n.days} 人日）`));
    s.append(kv('空闲', n.daysIdle == null ? '没有活动记录' : `${n.daysIdle} 天`));
    s.append(kv('下游', `${n.downstream} 个未完成节点在等它`));
  });

  sec('依赖', (s) => {
    if (!n.deps.length) return s.append(el('p', 'sub', '无依赖'));
    const ul = el('ul');
    for (const id of n.deps) {
      const dep = facts.nodes.find((x) => x.id === id);
      const li = el('li');
      li.append(el('span', 'mono', id), document.createTextNode(` ${dep ? dep.title : ''}`));
      ul.append(li);
    }
    s.append(ul);
    if (n.blockedBy.length) s.append(el('p', 'sub', `当前未完成：${n.blockedBy.join('、')}`));
  });

  sec('验收标准', (s) => s.append(el('p', '', n.acceptance || '—')));

  const agentSec = sec('Agent 下一步', (s) => {
    s.append(el('p', 'sub', '读取简报中…'));
  });
  loadAgent(false, ctx, active)
    .then((a) => {
      if (!active()) return;
      const node = a.nodes.find((x) => x.id === n.id);
      agentSec.innerHTML = '';
      agentSec.append(el('h4', '', 'Agent 下一步'));
      if (!node) return agentSec.append(el('p', 'sub', '简报里没有这个节点。'));
      const ol = el('ol');
      for (const step of node.next) ol.append(el('li', '', step));
      agentSec.append(ol);
      const acts = el('div', 'agent-actions');
      const copy = el('button', 'btn ghost', '复制节点简报 md');
      copy.onclick = async () => {
        try {
          const text = await fetchNodeMd(n.id, ctx, active);
          if (!active()) return;
          const ok = await copyText(text, `${n.id}.brief.md`, active);
          if (active()) toast(ok ? `已复制 ${n.id} 简报` : '剪贴板不可用，已改为下载简报 md');
        } catch (err) {
          if (active() && err.code !== 'STALE_REQUEST') toast('复制失败：' + err.message);
        }
      };
      const open = el('button', 'btn ghost', '看完整简报');
      open.onclick = () => openAgentModal(n.id);
      acts.append(copy, open);
      agentSec.append(acts);
      agentSec.append(el('p', 'sub', `写回仓库后位于 ${node.markdownPath}`));
    })
    .catch((err) => {
      if (!active() || err.code === 'STALE_REQUEST') return;
      agentSec.innerHTML = '';
      agentSec.append(el('h4', '', 'Agent 下一步'));
      agentSec.append(el('p', 'sub', '简报不可用：' + err.message));
    });

  sec('涉及文件', (s) => {
    if (!n.files?.length) return s.append(el('p', 'sub', '—'));
    const ul = el('ul');
    for (const f of n.files) ul.append(el('li', 'mono', f));
    s.append(ul);
  });

  sec('证据', (s) => {
    if (!n.issues.length && !n.prs.length && !n.branch && !n.commits.length) {
      return s.append(el('p', 'sub', '还没有任何关联证据'));
    }
    for (const i of n.issues) s.append(kv('issue', `#${i.number} ${i.state} ${i.title}`));
    for (const p of n.prs) {
      const row = kv('PR', `#${p.number} ${p.merged_at ? '已合并' : p.state}`);
      const st = baseState(p, currentHash);
      if (st === 'old') {
        const tag = el('span', 'base-tag old', '基于旧简报');
        tag.title = `PR 声明基准 ${shortBase(prBaseOf(p))}，PR 创建前已有更新的简报（当前 ${shortBase(currentHash)}）`;
        row.append(tag);
      } else if (st === 'bad') {
        const tag = el('span', 'base-tag bad', 'base 标记无效');
        tag.title = 'PR 里的 pm:base 不是合法指纹';
        row.append(tag);
      }
      s.append(row);
    }
    if (n.branch) s.append(kv('分支', n.branch));
    if (n.commits.length) {
      const ul = el('ul');
      for (const c of n.commits.slice(0, 8)) ul.append(el('li', 'mono', `${c.sha} ${fmtDay(c.date)} ${c.message}`));
      s.append(ul);
    }
  });
}

async function loadAgent(force = false, ctx = projectContext(), valid = () => isCurrent(ctx)) {
  if (!isCurrent(ctx) || !valid() || !facts) throw staleRequest();
  if (AGENT && isCurrent(AGENT) && !force) return AGENT.data;
  const request = ++agentRequest;
  const active = () => isCurrent(ctx) && valid() && request === agentRequest;
  try {
    const res = await fetch(`/api/projects/${ctx.id}/agent?t=` + Date.now());
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!active()) throw staleRequest();
    AGENT = { ...ctx, data };
    return data;
  } catch (err) {
    if (!active()) throw staleRequest();
    throw err;
  }
}

async function fetchNodeMd(nodeId, ctx = projectContext(), valid = () => isCurrent(ctx)) {
  if (!isCurrent(ctx) || !valid()) throw staleRequest();
  const res = await fetch(`/api/projects/${ctx.id}/agent/${encodeURIComponent(nodeId)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!isCurrent(ctx) || !valid()) throw staleRequest();
  return text;
}

function openAgentModal(nodeId = null) {
  if (!facts || projectLoading) return;
  closeDrawer();
  const ctx = projectContext();
  openModal(nodeId ? `Agent 简报 · ${nodeId}` : 'Agent 简报', '节点任务与 GitHub 证据深绑：同一份简报既能给人看，也能直接喂给 agent。', (m) => {
    const token = modalGeneration;
    const active = () => isCurrent(ctx) && token === modalGeneration;
    const body = el('div');
    body.append(el('p', 'sub', '正在生成…'));
    m.append(body);
    loadAgent(true, ctx, active)
      .then((a) => {
        if (!active()) return;
        body.innerHTML = '';
        const id = el('div', 'agent-identity');
        id.append(el('span', 'mono', '本机身份 '));
        const w = el('span', `who${a.identity?.memberId ? '' : ' none'}`);
        w.textContent = a.identity
          ? `${a.identity.login || a.identity.email || '未登录'} → ${a.identity.memberId || '未匹配成员'}`
          : '未识别';
        id.append(w);
        body.append(id);
        body.append(
          el(
            'p',
            'sub',
            `基准 ${fmtTime(a.asOf)} · 指纹 ${String(a.hash).slice(7, 15)} · 共 ${a.stats.nodes} 个节点，已完成 ${a.stats.done} · 本机负责 ${a.identity?.ownedNodes?.join('、') || '无'}`,
          ),
        );

        const list = el('div', 'agent-list');
        for (const n of a.nodes) {
          const row = el('div', 'row');
          row.dataset.id = n.id;
          row.append(el('span', 'id', n.id));
          const col = el('div');
          col.style.flex = '1';
          const t = el('div', 't', `${n.title}${n.forYou ? ' ★' : ''}`);
          const nx = el('div', 'agent-next', n.next[0] || '');
          col.append(t, nx);
          row.append(col, el('span', 'tag', n.state));
          list.append(row);
        }
        body.append(el('h4', '', '节点（★ = 本机负责）'));
        body.append(list);
        if (nodeId) {
          const target = list.querySelector(`[data-id="${nodeId}"]`);
          if (target) {
            target.classList.add('on');
            target.scrollIntoView({ block: 'center' });
          }
        }
        body.append(el('h4', '', '写回仓库后的位置'));
        const ul = el('ul');
        for (const p of [
          `.pm/${ctx.id}/manifest.json`,
          `.pm/${ctx.id}/bundle.parts/*.b64`,
          `.pm/${ctx.id}/AGENT.md`,
          `.pm/${ctx.id}/agent/index.json`,
          `.pm/${ctx.id}/agent/tasks/<节点>.md`,
          `.pm/${ctx.id}/interpretations/<提交>.md`,
        ]) ul.append(el('li', 'mono', p));
        body.append(ul);

        const acts = el('div', 'actions');
        const dlIndex = el('button', 'btn', '下载 index.json');
        dlIndex.onclick = () => { if (active()) downloadText(`${ctx.id}.agent.index.json`, JSON.stringify(a, null, 2)); };
        const dlMd = el('button', 'btn primary', '下载全部节点 md');
        dlMd.onclick = async () => {
          try {
            const parts = [];
            for (const n of a.nodes) parts.push(await fetchNodeMd(n.id, ctx, active));
            if (active()) downloadText(`${ctx.id}.agent.tasks.md`, parts.join('\n\n---\n\n'));
          } catch (err) {
            if (active() && err.code !== 'STALE_REQUEST') toast('导出失败：' + err.message);
          }
        };
        const dlGuide = el('button', 'btn', '下载生产指导');
        dlGuide.onclick = () => { if (active()) downloadText(`${ctx.id}.AGENT.md`, a.guide || ''); };
        const copyOnboard = el('button', 'btn', '复制接入提示词');
        copyOnboard.title = '任何 agent 通用：整段粘进会话即可按 PM 协议开工';
        copyOnboard.onclick = async () => {
          try {
            if (!active()) return;
            const res = await fetch(`/api/projects/${ctx.id}/onboarding?t=` + Date.now());
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            if (!active()) return;
            const ok = await copyText(j.text, `${ctx.id}.onboarding.md`, active);
            if (active()) toast(ok ? '接入提示词已复制，整段粘进 agent 会话' : '剪贴板不可用，已改为下载 onboarding.md');
          } catch (err) {
            if (active()) toast('复制失败：' + err.message);
          }
        };
        const close = el('button', 'btn ghost', '关闭');
        close.onclick = closeModal;
        acts.append(close, dlIndex, dlGuide, copyOnboard, dlMd);
        body.append(acts);
      })
      .catch((err) => {
        if (!active() || err.code === 'STALE_REQUEST') return;
        body.innerHTML = '';
        body.append(el('div', 'errbox', '简报生成失败：' + err.message));
      });
  });
}

function downloadText(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function copyText(text, fallbackName, valid = () => true) {
  if (!valid()) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (valid()) downloadText(fallbackName, text);
    return false;
  }
}

function closeDrawer() {
  ++drawerGeneration;
  $('#drawer').replaceChildren();
  $('#drawer').hidden = true;
  $('#mask').hidden = true;
}

/* ---------- 对话 ---------- */

function scrollChat() {
  const c = $('#chat');
  c.scrollTop = c.scrollHeight;
}

function msgEl(role, content) {
  const m = el('div', `msg ${role}`);
  if (role === 'assistant') m.innerHTML = mdLite(content);
  else m.textContent = content;
  return m;
}

function renderChat(id) {
  const box = $('#chat');
  box.innerHTML = '';
  const msgs = chats.get(id) || [];
  if (!msgs.length) {
    const empty = el('div', 'chat-empty');
    empty.append(el('div', 'ce-title', '和 PM 对话'));
    empty.append(
      el(
        'div',
        'ce-sub',
        chatMode === 'beginner'
          ? '用大白话问：现在真正卡在哪里、我今天该做什么。PM 会把术语拆开讲。'
          : '问进度、问取舍、问卡点根因。PM 会引用节点号、分支和证据。',
      ),
    );
    empty.append(el('div', 'ce-hint', '下面可以直接点一个问题开始'));
    box.append(empty);
    return;
  }
  for (const m of msgs) box.append(msgEl(m.role, m.content));
  scrollChat();
}

function renderMode() {
  const seg = $('#mode');
  seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === chatMode));
  const hint = $('#chat-hint');
  if (hint) hint.textContent = chatMode === 'beginner' ? '小白挡 · 讲人话' : '进阶挡 · 讲证据';
}

function renderPrompts() {
  const box = $('#prompts');
  box.innerHTML = '';
  const sets = {
    beginner: ['现在真正卡住的是什么？', '我今天该从哪一步开始？', '这个术语是什么意思？'],
    advanced: ['关键路径为什么这么排？', '哪条线最可能拖期？', '计划外提交里有哪些风险？'],
  };
  for (const p of sets[chatMode]) {
    const b = el('button', '', p);
    b.onclick = () => ask(p);
    box.append(b);
  }
}

async function ask(text) {
  const q = text.trim();
  if (!q || streaming || !currentId || !facts || projectLoading) return;
  const ctx = projectContext();
  streaming = true;
  $('#send').disabled = true;
  $('#q').value = '';
  const msgs = chats.get(currentId) || [];
  chats.set(currentId, msgs);
  msgs.push({ role: 'user', content: q });
  const box = $('#chat');
  box.querySelector('.chat-empty')?.remove();
  box.append(msgEl('user', q));

  const bot = el('div', 'msg bot pending', '思考中…');
  box.append(bot);
  scrollChat();

  let acc = '';
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (!acc && bot.isConnected) bot.textContent = `思考中… ${Math.round((Date.now() - t0) / 1000)}s`;
  }, 1000);

  const projectId = currentId;
  try {
    const res = await fetch(`/api/projects/${projectId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: msgs.slice(-10), mode: chatMode }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    if (!isCurrent(ctx)) { await res.body?.cancel(); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (!isCurrent(ctx)) { await reader.cancel(); return; }
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.trim().startsWith('data:'));
        if (!line) continue;
        const data = line.trim().slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new Error(j.error);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          acc += delta;
          if (bot.isConnected) {
            bot.classList.remove('pending');
            bot.textContent = acc;
            scrollChat();
          }
        }
      }
    }
    if (!acc) acc = '（空回复）';
    if (bot.isConnected) {
      bot.classList.remove('pending');
      bot.className = 'msg bot';
      bot.innerHTML = mdLite(acc);
    }
    msgs.push({ role: 'assistant', content: acc });
  } catch (err) {
    if (bot.isConnected) {
      bot.className = 'msg err';
      bot.textContent = `出错了：${String(err.message).slice(0, 300)}`;
    }
  } finally {
    clearInterval(timer);
    if (isCurrent(ctx)) {
      streaming = false;
      updateProjectActions();
      if (autoSyncReloadPending) {
        autoSyncReloadPending = false;
        autoSync(projectId);
      }
    }
  }
}

/* ---------- 空状态 ---------- */

function showWelcome(project) {
  $('#dashboard').hidden = true;
  const w = $('#welcome');
  w.hidden = false;
  w.innerHTML = '';
  if (project) {
    const isAdmin = ROLE.isAdmin;
    w.append(el('h2', '', `还没有「${project.name}」的审计数据`));
    w.append(el('p', '', `仓库 ${project.repo}。计划已存在，但还没有可核对的 GitHub 证据。`));
    const steps = el('ol');
    steps.append(el('li', '', '计划已就绪：先核对节点、依赖和验收标准是否完整。'));
    const next = el('li');
    if (isAdmin) {
      next.append(el('b', '', '你是管理员：'), document.createTextNode('点「拉取数据」生成第一份审计包，再选节点交给 Agent。'));
    } else {
      next.append(el('b', '', '你是只读身份：'), document.createTextNode('先点「同步」读仓库里的 PM 数据包；没有数据包就等管理员发布，或导入数据包。'));
    }
    steps.append(next);
    const bindStep = el('li');
    if (IDENTITY?.memberId) {
      bindStep.append(el('b', '', '身份已绑定：'), document.createTextNode(`${IDENTITY.login || IDENTITY.email || '本机身份'} → ${IDENTITY.memberId}。`));
    } else {
      bindStep.append(el('b', '', '身份未绑定：'), document.createTextNode('点右上角身份区完成成员映射，之后才能区分「我的节点」和个人任务。'));
    }
    steps.append(bindStep);
    w.append(steps);
    const actions = el('div', 'welcome-actions');
    if (isAdmin) {
      const b = el('button', 'btn primary', '拉取数据');
      b.dataset.projectAction = 'pull';
      b.onclick = () => pullData(project.id, b);
      actions.append(b);
    } else {
      const sync = el('button', 'btn primary', '同步数据包');
      sync.dataset.projectAction = 'sync';
      sync.onclick = syncNow;
      actions.append(sync);
    }
    const ex = el('button', 'btn', '导入数据包');
    ex.onclick = openImport;
    const bind = el('button', 'btn', IDENTITY?.memberId ? '核对身份映射' : '绑定已有成员');
    bind.onclick = openIdentity;
    actions.append(ex, bind);
    w.append(actions);
    w.append(el('p', 'muted', '只填仓库不会得到可靠进度；进度来自计划加上 GitHub 证据。拉取需要本机已登录 gh。'));
  } else {
    w.append(el('h2', '', '还没有项目数据'));
    w.append(el('p', '', '两种方式开始：'));
    const ol = el('ol');
    const li1 = el('li');
    li1.append(el('b', '', '导入数据包'), document.createTextNode('：拿到别人导出的 .bundle.pm.json，导入后用包内计划与证据重算指纹，一致才接收。'));
    const li2 = el('li');
    li2.append(el('b', '', '立项'), document.createTextNode('：填项目底座 → 生成调研 → 生成计划 → 创建，一次写好配置和计划。'));
    ol.append(li1, li2);
    w.append(ol);
    w.append(el('p', 'muted', '已经有 plan.json（或只能离线建项目）时，用「导入已有计划」直接建。'));
    w.append(el('p', 'muted', '数据格式 pm-audit/bundle v2：计划 + 证据 + 冻结时刻 asOf + SHA-256 指纹。指纹自洽不等于证据真实或验收通过；旧版包需管理员重新审计。'));
    const actions = el('div', 'welcome-actions');
    const b1 = el('button', 'btn primary', '导入数据包');
    b1.onclick = openImport;
    const b2 = el('button', 'btn', '＋ 立项');
    b2.onclick = openIntakeWizard;
    const b3 = el('button', 'btn ghost', '导入已有计划');
    b3.onclick = openNewProject;
    actions.append(b1, b2, b3);
    w.append(actions);
  }
  $('#pname').textContent = project ? project.name : 'PM 审计台';
  $('#repo').textContent = project ? project.repo : '';
  $('#fetched').textContent = '';
  $('#hash').textContent = '';
  $('#hash').title = '';
  if (project) {
    renderWho();
    renderRole();
  } else {
    $('#who').textContent = '请先选择项目';
    $('#role').textContent = '';
  }
  updateProjectActions();
  document.title = 'PM 审计台';
}

/* ---------- 拉取 / 刷新 ---------- */

async function pullData(id, btn) {
  const ctx = projectContext();
  if (id !== ctx.id || !ROLE.isAdmin || !beginProjectAction(ctx)) return;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '拉取中…（1–2 分钟）';
  try {
    const res = await withActionTimeout(fetch(`/api/projects/${id}/refresh`, { method: 'POST' }), '拉取');
    const j = await res.json();
    if (!isCurrent(ctx)) return;
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    await reloadProject(ctx);
  } catch (err) {
    if (isCurrent(ctx)) toast('拉取失败：' + err.message);
  } finally {
    if (isCurrent(ctx)) {
      btn.disabled = !ROLE.isAdmin;
      btn.textContent = old;
    }
    finishProjectAction(ctx);
  }
}

/* ---------- 弹窗基础 ---------- */

function openModal(title, sub, build, { wide = false } = {}) {
  ++modalGeneration;
  const m = $('#modal');
  m.innerHTML = '';
  m.classList.toggle('wide', wide);
  m.append(el('h3', '', title));
  if (sub) m.append(el('p', 'sub', sub));
  build(m);
  $('#modal-mask').hidden = false;
}

function closeModal() {
  ++modalGeneration;
  $('#modal-mask').hidden = true;
  const m = $('#modal');
  m.innerHTML = '';
  m.classList.remove('wide');
}

let fieldSequence = 0;
function field(parent, label, input, tip) {
  const l = el('label', '', label);
  if (!input.id) input.id = `field-${++fieldSequence}`;
  l.htmlFor = input.id;
  parent.append(l, input);
  if (tip) parent.append(el('div', 'tip', tip));
  return input;
}

function inputEl(type, placeholder, value) {
  const i = el('input');
  i.type = type;
  i.placeholder = placeholder || '';
  if (value != null) i.value = value;
  return i;
}

function actionsEl(parent, buttons) {
  const a = el('div', 'actions');
  for (const [label, cls, fn] of buttons) {
    const b = el('button', 'btn ' + (cls || ''), label);
    b.onclick = fn;
    a.append(b);
  }
  parent.append(a);
  return a;
}

function toast(text) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = el('div', 'toast');
    document.body.append(t);
  }
  t.textContent = text;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.remove(), 3200);
}

/* ---------- 设置弹窗 ---------- */

function updateSettingsUI() {
  $('#model').textContent = settings.model || '未配置模型';
  $('#side-status').textContent = settings.hasKey
    ? `${settings.model} · key ••••${settings.hint}`
    : settings.requiresKey === false ? settings.model : '未配置 API';
}

function openSettings() {
  openModal('API 设置', '密钥只保存在本机 .env。', (m) => {
    const providers = settings.providers?.length ? settings.providers : [
      { id: 'longcat', label: 'LongCat', baseUrl: 'https://api.longcat.chat/openai/v1', model: 'LongCat-2.5', requiresKey: true },
      { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', requiresKey: true },
      { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', requiresKey: true },
      { id: 'ollama', label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', requiresKey: false },
      { id: 'custom', label: '自定义', baseUrl: '', model: '', requiresKey: true },
    ];
    const provider = el('select');
    for (const item of providers) {
      const option = el('option', '', item.label);
      option.value = item.id;
      provider.append(option);
    }
    provider.value = settings.provider || 'longcat';
    field(m, '服务商', provider);

    const base = inputEl('text', 'https://…/v1', settings.baseUrl || '');
    field(m, 'Base URL', base, '填到 /v1；也兼容其他 OpenAI 格式地址。');
    const model = inputEl('text', '模型名', settings.model || '');
    field(m, '模型', model);
    const key = inputEl('password', settings.hasKey ? '留空保留当前 key' : 'sk-...');
    field(m, 'API Key', key, '更换服务商或地址后需重新填写；Ollama 无需 key。');

    const applyProvider = () => {
      const item = providers.find((entry) => entry.id === provider.value);
      if (!item) return;
      base.value = item.baseUrl;
      model.value = item.model;
      key.disabled = !item.requiresKey;
      key.placeholder = item.requiresKey ? 'sk-...' : '无需 key';
      if (!item.requiresKey) key.value = '';
    };
    provider.onchange = applyProvider;
    const current = providers.find((entry) => entry.id === provider.value);
    key.disabled = current ? !current.requiresKey : false;

    const msg = el('div');
    m.append(msg);
    actionsEl(m, [
      ['关闭', '', closeModal],
      [
        '保存',
        'primary',
        async (e) => {
          const btn = e.target;
          btn.disabled = true;
          try {
            const body = { provider: provider.value, baseUrl: base.value.trim(), model: model.value.trim() };
            if (key.value.trim()) body.apiKey = key.value.trim();
            const res = await fetch('/api/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            const j = await res.json();
            if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
            settings = j;
            updateSettingsUI();
            msg.innerHTML = '';
            msg.append(el('div', 'okbox', `已保存：${j.model}`));
          } catch (err) {
            msg.innerHTML = '';
            msg.append(el('div', 'errbox', String(err.message)));
          } finally {
            btn.disabled = false;
          }
        },
      ],
    ]);
  });
}

/* ---------- 导入弹窗 ---------- */

function openImport() {
  openModal('导入数据包', '导入后用包内计划和证据重算指纹，跟包内指纹一致才接收。', (m) => {
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.hidden = true;
    const drop = el('div', 'drop', '点击选择 .bundle.pm.json，或把文件拖到这里');
    drop.onclick = () => file.click();
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add('on');
    };
    drop.ondragleave = () => drop.classList.remove('on');
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove('on');
      pick(e.dataTransfer.files[0]);
    };
    file.onchange = () => pick(file.files[0]);
    m.append(drop, file);
    const info = el('div');
    m.append(info);
    let pending = null;

    async function pick(f) {
      if (!f) return;
      info.innerHTML = '';
      pending = null;
      try {
        const text = await f.text();
        const b = JSON.parse(text);
        const bundle = b.bundle || b;
        if (!bundle.format) throw new Error('不是数据包文件');
        pending = bundle;
        drop.textContent = f.name;
        info.append(
          el('div', 'okbox',
            `格式 ${bundle.format} v${bundle.version} · 项目 ${bundle.project?.name || '?'} · 基准 ${bundle.asOf || '?'} · 包内指纹 ${String(bundle.hashes?.facts || '').slice(0, 15)}`),
        );
      } catch (err) {
        info.append(el('div', 'errbox', '读取失败：' + err.message));
      }
    }

    async function doImport(force) {
      if (!pending) {
        info.innerHTML = '';
        info.append(el('div', 'errbox', '先选一个数据包文件。'));
        return;
      }
      const btn = m.querySelector('.actions .primary');
      btn.disabled = true;
      try {
        const res = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bundle: pending, force }),
        });
        const j = await res.json();
        if (!res.ok) {
          info.innerHTML = '';
          info.append(el('div', 'errbox', j.error || `HTTP ${res.status}`));
          if (j.forceable) {
            const fb = el('button', 'btn', '仍要强制导入（指纹会变，结果可能和对方不一致）');
            fb.style.marginTop = '10px';
            fb.onclick = () => doImport(true);
            info.append(fb);
          }
          return;
        }
        closeModal();
        toast(`已导入 ${j.id}，指纹 ${String(j.hash).slice(0, 15)}`);
        await loadProjects();
        await openProject(j.id);
      } catch (err) {
        info.innerHTML = '';
        info.append(el('div', 'errbox', String(err.message)));
      } finally {
        btn.disabled = false;
      }
    }

    actionsEl(m, [
      ['取消', '', closeModal],
      ['导入并校验', 'primary', () => doImport(false)],
    ]);
  });
}

/* ---------- 立项向导 ---------- */

function openIntakeWizard() {
  const STEP_NAMES = ['项目底座', '调研', '计划', '确认'];
  const state = {
    step: 1,
    id: '',
    name: '',
    repo: '',
    branch: 'main',
    localRepo: '',
    members: [],
    brief: { idea: '', users: '', problem: '', goals: [], nonGoals: [], constraints: [], metrics: [], unknowns: [], notes: '' },
    research: null,
    researchMarkdown: '',
    sources: [],
    warnings: [],
    plan: null,
    planSources: [],
    planValidated: false,
  };
  const splitLines = (v) => String(v || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const splitComma = (v) => String(v || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  const modelReady = () => Boolean(settings.hasKey) || settings.requiresKey === false;
  const memberCodes = () => state.members.map((m) => String(m.code || '').trim()).filter(Boolean);
  const membersObject = () => {
    const out = {};
    for (const m of state.members) {
      const code = String(m.code || '').trim();
      if (!code) continue;
      const entry = { name: String(m.name || '').trim() || code };
      const github = String(m.github || '').trim();
      if (github) entry.github = github;
      out[code] = entry;
    }
    return out;
  };
  const areaEl = (rows, placeholder, value) => {
    const t = el('textarea');
    t.rows = rows;
    t.placeholder = placeholder || '';
    if (value != null) t.value = value;
    return t;
  };
  const cell = (grid, full = false) => {
    const c = el('div', 'intake-cell' + (full ? ' span2' : ''));
    grid.append(c);
    return c;
  };
  const cleanedPlan = () => ({
    project: state.plan?.project || state.name.trim() || state.id.trim(),
    nodes: (state.plan?.nodes || []).map((n) => {
      const out = { id: String(n.id || '').trim(), title: String(n.title || '').trim() };
      if (n.owner) out.owner = n.owner;
      if (n.est) out.est = n.est;
      if (n.deps?.length) out.deps = n.deps;
      if (n.files?.length) out.files = n.files;
      if (n.acceptance) out.acceptance = n.acceptance;
      return out;
    }),
  });
  const planSourceText = () => {
    const docs = (state.planSources || []).filter((s) => s.kind === 'doc').map((s) => s.label);
    const issues = (state.planSources || []).filter((s) => s.kind === 'issue').length;
    const refs = [...docs];
    if (issues) refs.push(`${issues} 条 issue`);
    return `立项调研 research.md${refs.length ? `；参考 ${refs.join('、')}` : ''}`;
  };

  let flash = null;
  let nextBtn = null;

  openModal('立项向导', '四步把项目配置、调研和计划串起来；调研与计划都能改。创建前不会写任何文件。', (m) => {
    const stepsBar = el('div', 'intake-steps');
    const body = el('div', 'intake-body');
    const foot = el('div', 'actions');
    m.append(stepsBar, body, foot);

    const setFlash = (kind, text, details) => { flash = { kind, text, details }; };
    const renderFlash = () => {
      if (!flash) return null;
      const box = flash.kind === 'err' ? el('div', 'errbox') : el('div', 'okbox');
      box.append(el('div', '', flash.text));
      if (Array.isArray(flash.details) && flash.details.length) {
        const ul = el('ul', 'intake-errors');
        for (const d of flash.details) ul.append(el('li', '', d));
        box.append(ul);
      }
      flash = null;
      return box;
    };
    const renderFoot = (spec) => {
      foot.replaceChildren();
      nextBtn = null;
      for (const item of spec) {
        const b = el('button', 'btn ' + (item.cls || ''), item.label);
        b.type = 'button';
        if (item.disabled) b.disabled = true;
        b.onclick = item.fn;
        if (item.next) nextBtn = b;
        foot.append(b);
      }
    };
    const renderSteps = () => {
      stepsBar.replaceChildren();
      STEP_NAMES.forEach((label, i) => {
        const n = i + 1;
        const b = el('button', 'intake-step' + (n === state.step ? ' active' : n < state.step ? ' done' : ''), '');
        b.type = 'button';
        b.append(el('span', 'n', String(n)), el('span', '', label));
        if (n < state.step) b.onclick = () => { state.step = n; render(); };
        else b.disabled = true;
        stepsBar.append(b);
      });
    };

    const renderStep1 = () => {
      body.append(el('h4', '', '项目底座'));
      const grid = el('div', 'intake-grid');
      body.append(grid);

      const idInput = inputEl('text', 'dace', state.id);
      idInput.oninput = () => { state.id = idInput.value; };
      field(cell(grid), '项目 id *', idInput, '小写字母、数字和连字符，例如 dace。只用于目录名。');

      const nameInput = inputEl('text', 'DACE', state.name);
      nameInput.oninput = () => { state.name = nameInput.value; };
      field(cell(grid), '显示名称 *', nameInput);

      const repoCell = cell(grid, true);
      repoCell.append(el('label', '', 'GitHub 仓库 *'));
      const repoRow = el('div', 'intake-repo-row');
      const repoInput = inputEl('text', 'owner/name', state.repo);
      repoInput.oninput = () => { state.repo = repoInput.value; };
      const ghBtn = el('button', 'btn', '创建 GitHub 仓库');
      ghBtn.type = 'button';
      repoRow.append(repoInput, ghBtn);
      repoCell.append(repoRow, el('div', 'tip', '例如 alice/my-project。私有仓库需要本机 gh 已登录；没有仓库就先用按钮建一个。'));
      const ghSlot = el('div');
      repoCell.append(ghSlot);

      const branchInput = inputEl('text', 'main', state.branch);
      branchInput.oninput = () => { state.branch = branchInput.value; };
      field(cell(grid), '默认分支', branchInput, '默认 main。');

      const localInput = inputEl('text', 'E:/code/my-project（可留空）', state.localRepo);
      localInput.oninput = () => { state.localRepo = localInput.value; };
      field(cell(grid), '本地仓库路径', localInput, '填了会优先用本地 git 读提交。');

      body.append(el('h4', '', '成员'));
      body.append(el('p', 'tip', '成员代号会写进计划里的负责人 owner。没有成员也能继续，但计划 owner 必须留空。'));
      const membersBox = el('div', 'intake-members');
      state.members.forEach((member, i) => {
        const row = el('div', 'intake-member-row');
        const code = inputEl('text', 'm1', member.code);
        code.oninput = () => { member.code = code.value; };
        const name = inputEl('text', '甲', member.name);
        name.oninput = () => { member.name = name.value; };
        const github = inputEl('text', 'alice（可空）', member.github);
        github.oninput = () => { member.github = github.value; };
        const rm = el('button', 'mini', '删除');
        rm.type = 'button';
        rm.onclick = () => { state.members.splice(i, 1); render(); };
        row.append(code, name, github, rm);
        membersBox.append(row);
      });
      if (!state.members.length) membersBox.append(el('p', 'tip', '还没有成员。单人项目可以不填。'));
      body.append(membersBox);
      const addMember = el('button', 'mini', '+ 添加成员');
      addMember.type = 'button';
      addMember.onclick = () => { state.members.push({ code: '', name: '', github: '' }); render(); };
      body.append(addMember);

      const validateBase = () => {
        state.id = idInput.value.trim();
        state.name = nameInput.value.trim();
        state.repo = repoInput.value.trim();
        state.branch = branchInput.value.trim() || 'main';
        state.localRepo = localInput.value.trim();
        const errs = [];
        if (!/^[a-z0-9][a-z0-9-]*$/.test(state.id)) errs.push('项目 id 只能用小写字母、数字和连字符，并以字母或数字开头');
        if (!state.name) errs.push('显示名称不能为空');
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(state.repo)) errs.push('GitHub 仓库要填 owner/name，例如 alice/my-project');
        if (projects.some((p) => p.id === state.id)) errs.push(`本机已经有项目 ${state.id}，换一个 id 或打开已有项目`);
        const codes = new Set();
        state.members = state.members.filter((m) => String(m.code || '').trim() || String(m.name || '').trim() || String(m.github || '').trim());
        for (const m of state.members) {
          const code = String(m.code || '').trim();
          if (!code) { errs.push('成员代号不能为空（有成员没填代号）'); continue; }
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(code)) errs.push(`成员代号 "${code}" 只能用字母、数字、- 和 _`);
          else if (codes.has(code)) errs.push(`成员代号 "${code}" 重复`);
          else codes.add(code);
        }
        return errs;
      };

      const openGhPanel = async () => {
        ghSlot.replaceChildren();
        const panel = el('div', 'intake-gh');
        ghSlot.append(panel);
        const form = el('div', 'intake-grid');
        panel.append(form);
        const owner = inputEl('text', 'owner', '');
        const name = inputEl('text', 'repo-name', '');
        if (repoInput.value.includes('/')) {
          const [o, n] = repoInput.value.trim().split('/');
          owner.value = o || '';
          name.value = n || '';
        }
        const vis = el('select');
        for (const [val, label] of [['private', '私有'], ['public', '公开']]) {
          const opt = el('option', '', label);
          opt.value = val;
          vis.append(opt);
        }
        vis.value = 'private';
        const desc = inputEl('text', '可选说明', '');
        field(cell(form), 'owner *', owner);
        field(cell(form), '仓库名 *', name);
        field(cell(form), '可见性', vis);
        field(cell(form, true), '说明（可选）', desc);
        panel.append(el('p', 'tip', '会创建空仓库：只生成一个 README，并把默认分支设为 main。不推代码、不建 .pm/、不创建 PM 项目；同名仓库不会被覆盖。'));
        const accountLine = el('p', 'tip', '正在读取本机 gh 登录身份…');
        panel.append(accountLine);
        const msg = el('div');
        panel.append(msg);
        const actions = el('div', 'actions');
        const collapse = el('button', 'btn', '收起');
        collapse.type = 'button';
        collapse.onclick = () => ghSlot.replaceChildren();
        const previewBtn = el('button', 'btn primary', '检查并预览');
        previewBtn.type = 'button';
        actions.append(collapse, previewBtn);
        panel.append(actions);

        const gen = modalGeneration;
        try {
          const res = await fetch('/api/github/account');
          const j = await res.json();
          if (gen !== modalGeneration) return;
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          accountLine.textContent = `将以本机 gh 身份 ${j.login}${j.type === 'Organization' ? '（组织）' : ''} 创建；owner 可改成你有权限的组织。`;
          if (!owner.value) owner.value = j.login;
        } catch (err) {
          if (gen !== modalGeneration) return;
          accountLine.textContent = '读取本机 gh 身份失败：' + err.message + '。仍可手填 owner，但创建大概率会失败。';
          accountLine.className = 'tip errtext';
        }

        previewBtn.onclick = () => {
          msg.replaceChildren();
          const o = owner.value.trim();
          const n = name.value.trim();
          const isPrivate = vis.value === 'private';
          const preview = el('div', 'intake-preview');
          for (const [k, v] of [['owner', o || '（未填）'], ['仓库名', n || '（未填）'], ['完整名称', `${o}/${n}`], ['可见性', isPrivate ? '私有' : '公开'], ['初始化', '生成 README，默认分支 main']]) {
            const line = el('div', 'intake-kv');
            line.append(el('span', 'k', k), el('span', 'v', v));
            preview.append(line);
          }
          msg.append(preview);
          msg.append(el('p', 'tip', '确认后会直接调用本机 gh 创建仓库，这一步不可撤销。'));
          const finalActions = el('div', 'actions');
          const back = el('button', 'btn', '返回修改');
          back.type = 'button';
          back.onclick = () => msg.replaceChildren();
          const create = el('button', 'btn primary', '确认创建仓库');
          create.type = 'button';
          finalActions.append(back, create);
          msg.append(finalActions);
          create.onclick = async () => {
            create.disabled = true;
            const g = modalGeneration;
            try {
              const res = await fetch('/api/github/repo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ owner: o, name: n, private: isPrivate, description: desc.value.trim(), confirm: true }),
              });
              const j = await res.json();
              if (g !== modalGeneration) return;
              if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
              state.repo = j.full_name;
              state.branch = j.default_branch || 'main';
              repoInput.value = state.repo;
              branchInput.value = state.branch;
              msg.replaceChildren();
              msg.append(el('div', 'okbox', `仓库已建：${j.full_name}（${j.private ? '私有' : '公开'}，默认分支 ${j.default_branch}）。PM 项目还没创建，继续填完向导再点创建。`));
              if (j.warning) msg.append(el('div', 'intake-note', j.warning));
            } catch (err) {
              if (g !== modalGeneration) return;
              msg.replaceChildren();
              msg.append(el('div', 'errbox', '建仓失败：' + err.message));
            } finally {
              if (g === modalGeneration) create.disabled = false;
            }
          };
        };
      };
      ghBtn.onclick = openGhPanel;

      const baseErr = renderFlash();
      if (baseErr) body.append(baseErr);
      renderFoot([
        { label: '取消', fn: closeModal },
        {
          label: '下一步：调研',
          cls: 'primary',
          next: true,
          fn: () => {
            const errs = validateBase();
            if (errs.length) { setFlash('err', '项目底座还有问题：', errs); render(); return; }
            state.step = 2;
            render();
          },
        },
      ]);
    };

    const renderStep2 = () => {
      body.append(el('h4', '', '立项卡'));
      body.append(el('p', 'tip', state.repo
        ? `会读取 ${state.repo} 的 README、docs 和 open issue，与立项卡、补充材料一起送模型；不会联网检索。`
        : '未填仓库：只依据立项卡与补充材料，证据不足的部分会进入待验证。'));
      const grid = el('div', 'intake-grid');
      body.append(grid);

      const idea = inputEl('text', '一句话说清要做的事', state.brief.idea);
      idea.oninput = () => { state.brief.idea = idea.value; };
      field(cell(grid, true), '一句话想法 *', idea);

      const users = areaEl(2, '谁会用它', state.brief.users);
      users.oninput = () => { state.brief.users = users.value; };
      field(cell(grid), '目标用户', users);

      const problem = areaEl(2, '他们现在卡在哪', state.brief.problem);
      problem.oninput = () => { state.brief.problem = problem.value; };
      field(cell(grid), '要解决的问题', problem);

      const bindList = (node, key) => { node.oninput = () => { state.brief[key] = splitLines(node.value); }; };
      const goals = areaEl(3, '一行一条', state.brief.goals.join('\n'));
      bindList(goals, 'goals');
      field(cell(grid), '目标', goals);
      const nonGoals = areaEl(3, '一行一条', state.brief.nonGoals.join('\n'));
      bindList(nonGoals, 'nonGoals');
      field(cell(grid), '非目标 / 边界', nonGoals);
      const constraints = areaEl(3, '时间、技术、合规、人手', state.brief.constraints.join('\n'));
      bindList(constraints, 'constraints');
      field(cell(grid), '约束', constraints);
      const metrics = areaEl(3, '一行一条', state.brief.metrics.join('\n'));
      bindList(metrics, 'metrics');
      field(cell(grid), '成功指标', metrics);
      const unknowns = areaEl(3, '已知未知 / 风险', state.brief.unknowns.join('\n'));
      bindList(unknowns, 'unknowns');
      field(cell(grid), '已知未知', unknowns);
      const notes = areaEl(4, '访谈摘要、笔记、链接标题…本期只当文本，不抓 URL', state.brief.notes);
      notes.oninput = () => { state.brief.notes = notes.value; };
      field(cell(grid, true), '补充材料', notes);

      const canModel = modelReady();
      const tools = el('div', 'intake-tools');
      const genBtn = el('button', 'btn primary', state.research ? '重新生成调研' : '收集仓库资料并生成调研');
      genBtn.type = 'button';
      genBtn.disabled = !canModel;
      tools.append(genBtn);
      body.append(tools);
      if (!canModel) body.append(el('p', 'tip', '生成调研需要模型：先关闭向导，在左下角「API 设置」配好 key，再重新打开立项。'));

      const researchSlot = el('div');
      body.append(researchSlot);
      const renderResearchInto = () => {
        researchSlot.replaceChildren();
        if (state.research) {
          const facts = state.research.facts || [];
          const unknown = state.research.unknowns || [];
          researchSlot.append(el('p', 'tip', `结构：${facts.length} 条带来源事实 · ${unknown.length} 条待验证 · ${(state.research.validationQuestions || []).length} 个验证问题`));
        }
        if (state.sources.length) {
          const src = el('div', 'intake-sources');
          for (const s of state.sources) src.append(el('span', 'intake-source', `${s.id} · ${s.label}`));
          researchSlot.append(src);
        }
        for (const w of state.warnings) researchSlot.append(el('div', 'intake-warn', '· ' + w));
        researchSlot.append(el('h4', '', '调研 Markdown（可编辑）'));
        const md = areaEl(12, '生成后可在这里修改；改动会清空已生成的计划', state.researchMarkdown);
        md.className = 'intake-md';
        md.oninput = () => {
          state.researchMarkdown = md.value;
          if (state.plan) setFlash('err', '调研已修改，之前的计划草稿已清空，请在下一步重新生成计划。');
          state.plan = null;
          state.planValidated = false;
          state.planSources = [];
        };
        researchSlot.append(md);
        if (state.research && !(state.research.facts || []).length) {
          researchSlot.append(el('p', 'tip', '没有带有效来源的事实，证据不足的部分应留在待验证里。'));
        }
        const f = renderFlash();
        if (f) researchSlot.append(f);
      };
      renderResearchInto();

      genBtn.onclick = async () => {
        const gen = modalGeneration;
        state.brief.idea = idea.value.trim();
        if (!state.brief.idea) { setFlash('err', '先填一句话想法。'); render(); return; }
        genBtn.disabled = true;
        genBtn.textContent = '生成中…';
        const f = el('div', 'okbox', '正在读仓库文档与 issue，模型整理调研中…约半分钟');
        researchSlot.prepend(f);
        try {
          const res = await fetch('/api/intake/research', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brief: state.brief, repo: state.repo.trim() || undefined, branch: state.branch || 'main', local: state.localRepo.trim() || undefined }),
          });
          const j = await res.json();
          if (gen !== modalGeneration) return;
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          state.research = j.research;
          state.researchMarkdown = j.markdown || '';
          state.sources = j.sources || [];
          state.warnings = j.warnings || [];
          state.plan = null;
          state.planValidated = false;
          state.planSources = [];
          genBtn.textContent = '重新生成调研';
          renderResearchInto();
          setFlash('ok', `调研已生成（${state.sources.length} 个来源，${(state.research.facts || []).length} 条带来源事实）。逐条核对后再进下一步。`);
          render();
        } catch (err) {
          if (gen !== modalGeneration) return;
          f.remove();
          setFlash('err', '生成失败：' + err.message);
          render();
        } finally {
          genBtn.disabled = !modelReady();
          genBtn.textContent = state.research ? '重新生成调研' : '收集仓库资料并生成调研';
        }
      };

      renderFoot([
        { label: '上一步', fn: () => { state.step = 1; render(); } },
        {
          label: '下一步：写计划',
          cls: 'primary',
          next: true,
          fn: () => {
            state.brief.idea = idea.value.trim();
            if (!state.brief.idea) { setFlash('err', '立项卡还差一句话想法。'); render(); return; }
            if (!state.researchMarkdown.trim()) { setFlash('err', '先点「收集仓库资料并生成调研」，或在 Markdown 里手写调研。'); render(); return; }
            state.step = 3;
            render();
          },
        },
      ]);
    };

    const renderStep3 = () => {
      body.append(el('h4', '', '计划草稿'));
      body.append(el('p', 'tip', '生成只返回草稿，不写文件。可以改节点表，也可以导入已有计划 JSON；进入下一步前必须通过正式校验。'));

      const canModel = modelReady();
      const tools = el('div', 'intake-tools');
      const genBtn = el('button', 'btn ' + (state.plan ? 'ghost' : 'primary'), state.plan ? '重新生成（覆盖草稿）' : '根据调研生成计划');
      genBtn.type = 'button';
      genBtn.disabled = !canModel || !state.researchMarkdown.trim();
      tools.append(genBtn);

      const importFile = el('input');
      importFile.type = 'file';
      importFile.accept = '.json,application/json';
      importFile.hidden = true;
      const importBtn = el('button', 'btn ghost', '导入计划 JSON');
      importBtn.type = 'button';
      importBtn.onclick = () => importFile.click();
      tools.append(importBtn, importFile);
      let rawBtn = null;
      body.append(tools);
      if (!canModel) body.append(el('p', 'tip', '生成计划需要模型；也可以导入已有计划 JSON。'));

      importFile.onchange = async () => {
        const f = importFile.files?.[0];
        if (!f) return;
        try {
          const plan = JSON.parse(await f.text());
          if (!Array.isArray(plan.nodes) || !plan.nodes.length) throw new Error('缺少 nodes 数组');
          state.plan = plan;
          state.planValidated = false;
          state.planSources = [];
          if (!memberCodes().length && plan.members && typeof plan.members === 'object') {
            state.members = Object.entries(plan.members).map(([code, m]) => ({ code, name: m?.name || '', github: m?.github || '' }));
          }
          setFlash('ok', `已导入 ${plan.nodes.length} 个节点，记得重新校验。`);
          render();
        } catch (err) {
          setFlash('err', '计划文件有问题：' + err.message);
          render();
        }
      };

      const flashBox = renderFlash();
      if (flashBox) body.append(flashBox);

      let dirtyHint = null;
      const touch = () => {
        state.planValidated = false;
        if (dirtyHint) dirtyHint.hidden = false;
        if (nextBtn) nextBtn.disabled = true;
      };

      if (!state.plan) {
        body.append(el('p', 'tip', '还没有计划草稿。'));
        if (canModel && state.researchMarkdown.trim()) {
          body.append(el('div', 'okbox', '点「根据调研生成计划」让模型拆节点，或导入自己的 JSON。'));
        }
      } else {
        const plan = state.plan;
        const members = memberCodes();
        const nodeScroll = el('div', 'node-scroll');
        const table = el('table', 'node-table');
        const thead = el('thead');
        const hr = el('tr');
        for (const [label, cls] of [['id', 'col-id'], ['标题', ''], ['负责人', 'col-owner'], ['est', 'col-est'], ['依赖', 'col-deps'], ['文件', 'col-files'], ['验收标准', ''], ['', 'col-act']]) {
          const th = el('th', cls, label);
          hr.append(th);
        }
        thead.append(hr);
        const tbody = el('tbody');
        table.append(thead, tbody);
        nodeScroll.append(table);

        plan.nodes.forEach((node, index) => {
          const tr = el('tr');
          const td = (cls) => { const c = el('td', cls); tr.append(c); return c; };

          const idIn = inputEl('text', 'A1', node.id || '');
          idIn.oninput = () => { node.id = idIn.value; touch(); };
          td('col-id').append(idIn);

          const titleIn = inputEl('text', '节点标题', node.title || '');
          titleIn.oninput = () => { node.title = titleIn.value; touch(); };
          td().append(titleIn);

          const ownerSel = el('select');
          const optEmpty = el('option', '', '（空）');
          optEmpty.value = '';
          ownerSel.append(optEmpty);
          for (const code of members) { const o = el('option', '', code); o.value = code; ownerSel.append(o); }
          const curOwner = String(node.owner || '');
          if (curOwner && !members.includes(curOwner)) { const o = el('option', '', `${curOwner}（不在成员表）`); o.value = curOwner; ownerSel.append(o); }
          ownerSel.value = curOwner;
          ownerSel.onchange = () => { node.owner = ownerSel.value; touch(); };
          td('col-owner').append(ownerSel);

          const estSel = el('select');
          for (const val of ['', 'S', 'M', 'L']) { const o = el('option', '', val || '—'); o.value = val; estSel.append(o); }
          estSel.value = node.est || '';
          estSel.onchange = () => { node.est = estSel.value; touch(); };
          td('col-est').append(estSel);

          const depsIn = inputEl('text', 'A1, A2', (node.deps || []).join(', '));
          depsIn.oninput = () => { node.deps = splitComma(depsIn.value); touch(); };
          td('col-deps').append(depsIn);

          const filesIn = inputEl('text', 'a.js', (node.files || []).join(', '));
          filesIn.oninput = () => { node.files = splitComma(filesIn.value); touch(); };
          td('col-files').append(filesIn);

          const acc = areaEl(2, '可验证的验收标准', node.acceptance || '');
          acc.oninput = () => { node.acceptance = acc.value; touch(); };
          td().append(acc);

          const rm = el('button', 'mini', '删');
          rm.type = 'button';
          rm.onclick = () => { plan.nodes.splice(index, 1); state.planValidated = false; render(); };
          td('col-act').append(rm);

          tbody.append(tr);
        });

        body.append(nodeScroll);
        const addRow = el('button', 'mini', '+ 添加节点');
        addRow.type = 'button';
        addRow.disabled = plan.nodes.length >= 40;
        addRow.onclick = () => {
          if (plan.nodes.length >= 40) return;
          plan.nodes.push({ id: '', title: '', owner: '', est: '', deps: [], files: [], acceptance: '' });
          state.planValidated = false;
          render();
        };
        body.append(addRow);

        const jsonPre = el('pre', 'intake-json', JSON.stringify(plan, null, 2));
        jsonPre.hidden = true;
        body.append(jsonPre);
        rawBtn = el('button', 'btn ghost', '查看原始 JSON');
        rawBtn.type = 'button';
        rawBtn.onclick = () => {
          jsonPre.textContent = JSON.stringify(plan, null, 2);
          jsonPre.hidden = !jsonPre.hidden;
          rawBtn.textContent = jsonPre.hidden ? '查看原始 JSON' : '收起原始 JSON';
        };
        tools.append(rawBtn);

        dirtyHint = el('p', 'tip', '计划尚未通过校验；改过之后还要再校验一次。');
        dirtyHint.hidden = state.planValidated;
        body.append(dirtyHint);

        const validateBtn = el('button', 'btn primary', '校验计划');
        validateBtn.type = 'button';
        tools.append(validateBtn);
        validateBtn.onclick = async () => {
          const gen = modalGeneration;
          validateBtn.disabled = true;
          try {
            const planToSend = cleanedPlan();
            const res = await fetch('/api/intake/validate-plan', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ plan: planToSend, members: membersObject() }),
            });
            const j = await res.json();
            if (gen !== modalGeneration) return;
            if (!res.ok) {
              state.planValidated = false;
              const details = Array.isArray(j.details) ? j.details : [];
              if (details.length) setFlash('err', '计划没通过校验：', details);
              else setFlash('err', j.error || `HTTP ${res.status}`);
              render();
              return;
            }
            state.plan = planToSend;
            state.planValidated = true;
            setFlash('ok', `校验通过：${j.nodes} 个节点。`);
            render();
          } catch (err) {
            if (gen !== modalGeneration) return;
            state.planValidated = false;
            setFlash('err', '校验请求失败：' + err.message);
            render();
          } finally {
            if (gen === modalGeneration) validateBtn.disabled = false;
          }
        };
      }

      const generatePlan = async () => {
        const gen = modalGeneration;
        state.planValidated = false;
        if (!state.researchMarkdown.trim()) { setFlash('err', '缺调研 Markdown，先回上一步生成或手写。'); render(); return; }
        genBtn.disabled = true;
        genBtn.textContent = '生成中…';
        const busy = el('div', 'okbox', '正在根据调研拆计划草稿…');
        body.prepend(busy);
        try {
          const res = await fetch('/api/intake/plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              brief: state.brief,
              researchMarkdown: state.researchMarkdown,
              repo: state.repo.trim() || undefined,
              branch: state.branch || 'main',
              local: state.localRepo.trim() || undefined,
              members: membersObject(),
            }),
          });
          const j = await res.json();
          if (gen !== modalGeneration) return;
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          state.plan = j.plan;
          state.planSources = j.sourceCatalog || [];
          state.planValidated = false;
          setFlash('ok', `已生成 ${j.plan.nodes.length} 个节点草稿；逐条核对后再校验。`);
          render();
        } catch (err) {
          if (gen !== modalGeneration) return;
          busy.remove();
          setFlash('err', '生成计划失败：' + err.message);
          render();
        } finally {
          genBtn.disabled = !modelReady() || !state.researchMarkdown.trim();
          genBtn.textContent = state.plan ? '重新生成（覆盖草稿）' : '根据调研生成计划';
        }
      };
      genBtn.onclick = generatePlan;

      renderFoot([
        { label: '上一步', fn: () => { state.step = 2; render(); } },
        {
          label: '下一步：确认',
          cls: 'primary',
          next: true,
          disabled: !state.planValidated,
          fn: () => {
            if (!state.plan || !state.planValidated) { setFlash('err', '计划还没通过校验：先点「校验计划」。'); render(); return; }
            state.step = 4;
            render();
          },
        },
      ]);
    };

    const renderStep4 = () => {
      body.append(el('h4', '', '确认创建'));
      const summary = el('div', 'intake-summary');
      const unknowns = state.research?.unknowns?.length || 0;
      const facts = state.research?.facts?.length || 0;
      const rows = [
        ['项目 id', state.id],
        ['显示名称', state.name],
        ['GitHub 仓库', state.repo],
        ['默认分支', state.branch || 'main'],
        ['成员', `${memberCodes().length} 人`],
        ['计划节点', `${state.plan?.nodes?.length || 0} 个`],
        ['调研来源', `${state.sources.length} 项`],
        ['带来源事实', `${facts} 条`],
        ['未验证问题', `${unknowns} 条`],
      ];
      for (const [k, v] of rows) {
        const item = el('div', 'intake-kv-line');
        item.append(el('span', 'k', k), el('span', 'v', v));
        summary.append(item);
      }
      body.append(summary);
      body.append(el('div', 'intake-note', '调研是 AI 草稿，不是事实认证。它和 plan.json 会写到本机 projects/<id>/，不会自动推送到远端。'));

      const flashBox = renderFlash();
      if (flashBox) body.append(flashBox);
      const msg = el('div');
      body.append(msg);

      renderFoot([
        { label: '返回修改', fn: () => { state.step = 3; render(); } },
        {
          label: '创建项目',
          cls: 'primary',
          fn: async (e) => {
            const btn = e.target;
            const gen = modalGeneration;
            btn.disabled = true;
            msg.replaceChildren();
            try {
              const res = await fetch('/api/projects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  id: state.id,
                  name: state.name,
                  repo: state.repo,
                  localRepo: state.localRepo || null,
                  defaultBranch: state.branch || 'main',
                  members: membersObject(),
                  plan: cleanedPlan(),
                  planSource: planSourceText(),
                  intake: {
                    brief: state.brief,
                    research: state.research,
                    markdown: state.researchMarkdown,
                    sources: state.sources,
                  },
                }),
              });
              const j = await res.json();
              if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
              closeModal();
              await loadProjects();
              await openProject(j.id);
              toast('项目已创建，点「拉取数据」执行首次审计');
            } catch (err) {
              if (gen !== modalGeneration) { toast('创建后刷新失败：' + err.message); return; }
              msg.replaceChildren();
              msg.append(el('div', 'errbox', String(err.message)));
              btn.disabled = false;
            }
          },
        },
      ]);
    };

    const render = () => {
      renderSteps();
      body.replaceChildren();
      if (state.step === 1) renderStep1();
      else if (state.step === 2) renderStep2();
      else if (state.step === 3) renderStep3();
      else renderStep4();
    };
    render();
  }, { wide: true });
}

function openNewProject() {
  openModal('导入已有计划', '手里已有任务计划 JSON？选文件直接建项目；没有计划就回侧栏「＋ 立项」走向导。建好后点「拉取数据」读 GitHub。', (m) => {
    const id = inputEl('text', 'dace');
    field(m, '项目 id（小写字母/数字/连字符）', id, '只用于目录名，例如 dace。');
    const name = inputEl('text', 'DACE');
    field(m, '显示名称', name);
    const repo = inputEl('text', 'owner/name');
    field(m, 'GitHub 仓库', repo, '例如 alice/my-project。私有仓库需要本机 gh 已登录。');
    const local = inputEl('text', 'E:/code/my-project（可留空）');
    field(m, '本地仓库路径', local, '填了会优先用本地 git 读提交，比 API 快且稳。');
    const planFile = el('input');
    planFile.type = 'file';
    planFile.accept = '.json,application/json';
    field(m, '任务计划 JSON', planFile, '格式：{"project":"...","nodes":[{"id":"A1","title":"...","owner":"A","est":"M","deps":[],"files":[],"acceptance":"..."}]}。工期 est 用 S/M/L。');
    const draftBtn = el('button', 'btn', '从仓库生成草稿（需模型 key）');
    draftBtn.type = 'button';
    draftBtn.style.margin = '0 0 10px';
    draftBtn.title = '读 README/docs 与 open issue，让模型拆成计划草稿；不会覆盖任何正式计划';
    draftBtn.onclick = async () => {
      msg.innerHTML = '';
      const r = repo.value.trim();
      if (!r) {
        msg.append(el('div', 'errbox', '先填 GitHub 仓库，再生成草稿。'));
        return;
      }
      draftBtn.disabled = true;
      msg.append(el('div', 'okbox', '正在读仓库文档与 issue，模型拆解中…约半分钟'));
      try {
        const res = await fetch('/api/plan-draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: r, id: id.value.trim() || undefined, local: local.value.trim() || undefined }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
        plan = j.plan;
        msg.innerHTML = '';
        msg.append(el('div', 'okbox', `草稿 ${plan.nodes.length} 个节点（来源：${j.sources.docs.join('、') || '无文档'} + ${j.sources.issues} 条 issue）。草稿务必逐条核对后再创建。`));
        const dl = el('button', 'btn ghost', '下载草稿 JSON');
        dl.type = 'button';
        dl.onclick = () => downloadText('plan.draft.json', JSON.stringify(plan, null, 2));
        msg.append(dl);
      } catch (err) {
        msg.innerHTML = '';
        msg.append(el('div', 'errbox', '草稿生成失败：' + err.message));
      } finally {
        draftBtn.disabled = false;
      }
    };
    m.append(draftBtn);
    const source = inputEl('text', '计划来源说明（可留空）');
    field(m, '计划来源', source, '例如 docs/团队分工与里程碑.md。会写进数据包。');
    const msg = el('div');
    m.append(msg);

    let plan = null;
    planFile.onchange = async () => {
      msg.innerHTML = '';
      plan = null;
      const f = planFile.files[0];
      if (!f) return;
      try {
        plan = JSON.parse(await f.text());
        if (!Array.isArray(plan.nodes) || !plan.nodes.length) throw new Error('缺少 nodes 数组');
        msg.append(el('div', 'okbox', `已读取 ${plan.nodes.length} 个节点。`));
      } catch (err) {
        plan = null;
        msg.append(el('div', 'errbox', '计划文件有问题：' + err.message));
      }
    };

    actionsEl(m, [
      ['取消', '', closeModal],
      [
        '创建',
        'primary',
        async (e) => {
          const btn = e.target;
          msg.innerHTML = '';
          if (!plan) {
            msg.append(el('div', 'errbox', '先选任务计划 JSON。'));
            return;
          }
          btn.disabled = true;
          try {
            const res = await fetch('/api/projects', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: id.value.trim(),
                name: name.value.trim() || id.value.trim(),
                repo: repo.value.trim(),
                localRepo: local.value.trim() || null,
                plan,
                members: plan.members || undefined,
                planSource: source.value.trim() || plan.source || '',
              }),
            });
            const j = await res.json();
            if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
            closeModal();
            await loadProjects();
            await openProject(j.id);
            toast('项目已创建，点「拉取数据」读 GitHub');
          } catch (err) {
            msg.append(el('div', 'errbox', String(err.message)));
          } finally {
            btn.disabled = false;
          }
        },
      ],
    ]);
  });
}

/* ---------- 说明 ---------- */

function openHelp() {
  openModal('使用说明', '本地优先，数据可随身带走。', (m) => {
    const sec = (t, html) => {
      m.append(el('h4', '', t));
      const p = el('p', 'tip');
      p.innerHTML = html;
      m.append(p);
    };
    sec('启动 / 关闭', '双击 scripts\\start.cmd 启动，scripts\\stop.cmd 关闭；浏览器打开 http://127.0.0.1:7317。');
    sec('数据从哪来', 'gh 读远程仓库的 issue、PR、分支、提交；本机有仓库目录时优先用本地 git。所有时间以 asOf 为基准，结果可复现。');
    sec('立项', '侧栏「＋ 立项」四步走完：项目底座 → 调研 → 计划 → 确认。调研和计划都由模型出草稿、你来改；进入确认前计划必须通过校验。创建只写本机 <code>projects/&lt;id&gt;/</code>（project.json、plan.json、intake.json、research.md），不推送远端。「创建 GitHub 仓库」按钮需要本机 gh 已登录，只在你点了之后才建仓。');
    sec('数据包在仓库里', '刷新后指纹变化会自动写回 <code>.pm/&lt;项目&gt;/</code>（bundle、manifest、每个节点的 Agent 简报）。别人打开 PM 时会先读 manifest，发现有更新就自动拉取并校验；手动入口是右上「同步」「写回」。');
    sec('谁能改数据', '管理员 = <code>project.json</code> 的 <code>admin</code>、<code>admins[]</code>，以及所有已绑定 <code>members[].github</code> 的成员；未绑定登录名的成员仍是只读。写回、PR 备注、归位执行只对管理员开放，同步时也会校验远端 <code>.pm/</code> 最后一次提交作者是否在管理员列表里。');
    sec('只有一个进度文件', '进度数据只落一份：仓库里固定为 <code>.pm/&lt;项目&gt;/</code> 的 bundle + manifest + Agent 简报，不按人分文件；写回会整树覆盖并删除旧分片。若远端数据包比本地新，写回返回 409 并提示先同步或刷新，避免用旧快照覆盖唯一的进度文件。');
    sec('只读用户能做什么', '照样看审计图、卡点、关键路径、问对话、导出数据包；能拿到归位命令并复制给管理员执行。要改进度数据，请先把 GitHub 登录名绑到成员上，再由本人刷新并写回。');
    sec('两种对话', '「小白」挡讲人话，直奔下一步；「进阶」挡给结论、证据和取舍。两种都会先标出你的身份和负责的节点。');
    sec('给 Agent 的简报', '点对话卡片的「Agent 简报」或节点详情里的「复制节点简报 md」。生产指导在 <code>.pm/&lt;项目&gt;/AGENT.md</code>，节点简报绑验收、依赖、证据和下一步，位于 <code>.pm/&lt;项目&gt;/agent/</code>。');
    sec('本机身份', 'PM 用 <code>gh api user</code> 和 <code>git config user.email</code> 识别你是谁，映射到项目的 members[].github；识别不到就只显示账号，不影响审计。');
    sec('分享给别人', '点右上「导出」得到 <code>.bundle.pm.json</code>。对方导入后会用包内计划和证据重算 SHA-256 指纹，一致才接收；不一致可以强制导入，但会标出来。');
    sec('API 配置', '支持 LongCat、OpenAI、DeepSeek、Ollama 和自定义 OpenAI 兼容服务。密钥只写本机 .env，不进前端、数据包或仓库。');
    sec('证据怎么挂到节点', '分支命名 <code>task/A2</code>；issue/PR 正文写 <code>&lt;!-- pm:node=A2 --&gt;</code>；提交或 PR 标题带 <code>[A2]</code>。');
    sec('命令行', '<code>node bin/pmctl.mjs audit &lt;id&gt; --fresh</code> 拉数据；<code>sync</code> / <code>publish</code> 同步与写回；<code>agent &lt;id&gt;</code> 生成本机简报；<code>watch --once</code> 解读新提交。');
    actionsEl(m, [['知道了', 'primary', closeModal]]);
  });
}

/* ---------- 事件绑定 ---------- */

$('#mask').addEventListener('click', closeDrawer);
$('#modal-mask').addEventListener('click', (e) => {
  if (e.target === $('#modal-mask')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDrawer();
    closeModal();
  }
});

$('#btn-new').onclick = openIntakeWizard;
$('#btn-import').onclick = openImport;
$('#btn-settings').onclick = openSettings;
$('#btn-help').onclick = openHelp;
$('#btn-sync').onclick = syncNow;
$('#btn-publish').onclick = publishNow;
$('#btn-agent').onclick = openAgentModal;
$('#mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !b.dataset.mode || b.dataset.mode === chatMode) return;
  chatMode = b.dataset.mode;
  localStorage.setItem('pm.chatMode', chatMode);
  renderMode();
  renderChat(currentId);
  renderPrompts();
  $('#q').focus();
});

async function refreshData({ auto = false } = {}) {
  const ctx = projectContext();
  if (!beginProjectAction(ctx)) return;
  try {
    const res = await withActionTimeout(fetch(`/api/projects/${ctx.id}/refresh${auto ? '?auto=1' : ''}`, { method: 'POST' }), '刷新');
    const j = await res.json();
    if (!isCurrent(ctx)) return;
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    if (j.skipped) {
      if (!auto) toast(`未刷新：${j.reason || '远端无变化'}`);
      return;
    }
    if (j.readOnly) {
      const st = j.sync?.status;
      if (!auto) {
        if (st === 'updated') toast(`只读模式：已从仓库同步 ${String(j.hash).slice(7, 15)}`);
        else if (st === 'untrusted') toast(`只读：远端数据包作者 ${j.sync.author || '未知'} 不是管理员，已拒绝加载`);
        else if (st === 'absent') toast('只读：仓库里还没有 PM 数据包');
        else if (st === 'invalid') toast('只读：远端数据包校验失败，已忽略');
        else toast('只读模式：已是最新数据');
      }
    } else {
      if (j.publish?.status === 'published') {
        toast(`已写回仓库：${j.publish.changed} 个文件 · ${String(j.publish.commit).slice(0, 8)}`);
      } else if (j.publish?.status === 'error') {
        toast('刷新成功，但写回失败：' + j.publish.error);
      } else if (j.publish?.status === 'local-only' && !auto) {
        toast('已刷新本地数据，远端无变化，未写回');
      }
      if (j.interpreted?.comments?.length) {
        const c = j.interpreted.comments.filter((x) => x.status === 'posted' || x.status === 'updated');
        if (c.length) toast(`已解读新提交并评论 ${c.length} 个 PR`);
      }
    }
    await reloadProject(ctx);
  } catch (err) {
    if (isCurrent(ctx) && !auto) toast('刷新失败：' + err.message);
  } finally {
    finishProjectAction(ctx);
  }
}
$('#refresh').onclick = () => refreshData();

let autoTimer = 0;
function setAuto(on) {
  localStorage.setItem('pm.auto', on ? '1' : '0');
  const b = $('#btn-auto');
  b.classList.toggle('on', on);
  b.title = on ? '自动已开：每 10 分钟检查远端，有变化才刷新并写回' : '每 10 分钟检查远端，有变化才刷新并写回';
  clearInterval(autoTimer);
  if (on) autoTimer = setInterval(() => { if (currentId && !document.hidden) refreshData({ auto: true }); }, 10 * 60 * 1000);
}
$('#btn-auto').onclick = () => setAuto(localStorage.getItem('pm.auto') !== '1');
$('#btn-prnote').onclick = openPrNote;
$('#btn-trail-md').onclick = () => {
  if (!TRAIL?.data?.markdown || !isCurrent(TRAIL)) return toast('证据链还没加载好，稍后再试');
  downloadText(`${currentId}.trail.md`, TRAIL.data.markdown);
};
initPager();
initGraphPan();

$('#export').onclick = () => {
  if (!currentId || !facts || projectLoading) return;
  location.href = `/api/projects/${currentId}/export`;
};

$('#send').onclick = () => ask($('#q').value);
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ask(e.target.value);
  }
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    hidePeek();
    if (facts) renderGraph();
  }, 150);
});
window.addEventListener('scroll', hidePeek, true);

/* ---------- 启动 ---------- */

(async function boot() {
  try {
    settings = await (await fetch('/api/settings')).json();
  } catch (err) {
    console.error('读取设置失败', err);
  }
  updateSettingsUI();
  renderMode();
  setAuto(localStorage.getItem('pm.auto') === '1');
  try {
    await loadProjects();
  } catch (err) {
    console.error('读取项目失败', err);
    showWelcome(null);
    toast('连不上本地服务，先运行 scripts\\start.cmd');
    return;
  }
  const saved = localStorage.getItem('pm.current');
  const pick = projects.find((p) => p.id === saved) || projects[0];
  if (pick) {
    const loading = openProject(pick.id);
    const generation = projectGeneration;
    if (!await loading || generation !== projectGeneration) return;
  } else showWelcome(null);
  const deepPage = Number(new URLSearchParams(location.search).get('page'));
  if (Number.isInteger(deepPage) && deepPage >= 0 && deepPage < PAGE_COUNT) goPage(deepPage);
})();
