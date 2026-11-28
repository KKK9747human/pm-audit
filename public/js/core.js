// PM 审计台 · 前端「核心工具与全局状态」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

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
