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

const LABEL = { done: '完成', active: '进行中', stale: '停滞', blocked: '被阻塞', ready: '待启动' };
const FILL = { done: '#0e2b21', active: '#0b2735', stale: '#2b2113', blocked: '#2a1119', ready: '#111922' };
const STROKE = { done: '#2fd48a', active: '#38d6ea', stale: '#f0a94a', blocked: '#f4587a', ready: '#5b6c7f' };
const TEXT2 = '#dbe9f6';

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
let BRIEF_HISTORY = [];
let settings = { hasKey: false, hint: '', model: 'LongCat-2.5' };
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

/* ---------- 侧栏 / 项目 ---------- */

async function loadProjects() {
  const res = await fetch('/api/projects?t=' + Date.now());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  projects = await res.json();
  renderSidebar();
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
    b.append(pn, el('div', 'pr', '', p.repo));
    if (p.stats) {
      const ps = el('div', 'ps');
      const item = (cls, n, title) => {
        const i = el('i', cls, String(n));
        i.title = title;
        return i;
      };
      ps.append(
        item('done', p.stats.done, '完成'),
        item('active', p.stats.active + p.stats.stale, '进行中+停滞'),
        item('blocked', p.stats.blocked, '被阻塞'),
      );
      b.append(ps);
    }
    b.onclick = () => openProject(p.id);
    box.append(b);
  }
}

async function openProject(id, { sync = true } = {}) {
  closeDrawer();
  closeModal();
  const prevId = currentId;
  currentId = id;
  localStorage.setItem('pm.current', id);
  renderSidebar();
  try {
    const res = await fetch(`/api/projects/${id}?t=` + Date.now());
    if (res.status === 404) {
      PROJECT = projects.find((p) => p.id === id) || { id, name: id, repo: '' };
      facts = null;
      IDENTITY = null;
      ROLE = { isAdmin: false, admin: null };
      AGENT = null;
      showWelcome(PROJECT);
      return;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const bundle = await res.json();
    PROJECT = bundle.project;
    facts = bundle.facts;
    IDENTITY = bundle.identity || null;
    ROLE = { isAdmin: Boolean(bundle.isAdmin), admin: bundle.admin || null };
    PUBLISHED = bundle.published || null;
    BRIEF_HISTORY = Array.isArray(bundle.briefHistory) ? bundle.briefHistory : [];
    AGENT = null;
    currentHash = bundle.hashes?.facts || null;
    renderAll();
    if (prevId !== id) goPage(0);
    if (sync) autoSync(id);
  } catch (err) {
    console.error('加载失败', err);
    toast('加载项目失败：' + err.message);
  }
}

async function autoSync(id) {
  try {
    const res = await fetch(`/api/projects/${id}/sync`, { method: 'POST' });
    if (!res.ok) return;
    const j = await res.json();
    if (id !== currentId) return;
    if (j.status === 'updated') {
      await loadProjects();
      await openProject(id, { sync: false });
      toast(`已读取仓库里的 PM 数据包 ${String(j.hash).slice(7, 15)}`);
    } else if (j.status === 'invalid') {
      toast('仓库里的 PM 数据包校验失败，已忽略');
    } else if (j.status === 'untrusted') {
      toast(`拒绝加载：远端数据包作者 ${j.author || '未知'} 不是管理员 ${j.expectedAdmin}`);
    }
  } catch {}
}

async function syncNow() {
  if (!currentId) return;
  const id = currentId;
  const b = $('#btn-sync');
  const old = b.textContent;
  b.disabled = true;
  b.textContent = '同步中…';
  try {
    const res = await fetch(`/api/projects/${id}/sync?force=1`, { method: 'POST' });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    if (j.status === 'updated') {
      await loadProjects();
      await openProject(id, { sync: false });
      toast(`已读取仓库里的 PM 数据包 ${String(j.hash).slice(7, 15)}`);
    } else if (j.status === 'same') {
      toast('远端已是最新，没有更新');
    } else if (j.status === 'absent') {
      toast('仓库里还没有 PM 数据包，点「写回」发布第一份');
    } else if (j.status === 'untrusted') {
      toast(`拒绝加载：远端数据包作者 ${j.author || '未知'} 不是管理员 ${j.expectedAdmin}`);
    } else {
      toast('远端数据包校验失败，已忽略');
    }
  } catch (err) {
    toast('同步失败：' + err.message);
  } finally {
    b.disabled = false;
    b.textContent = old;
  }
}

async function publishNow() {
  if (!currentId || !facts) return;
  if (!ROLE.isAdmin) {
    toast(`只读模式：项目进度数据由管理员（${ROLE.admin || '未设置'}）维护`);
    return;
  }
  const b = $('#btn-publish');
  const old = b.textContent;
  b.disabled = true;
  b.textContent = '写回中…';
  try {
    const res = await fetch(`/api/projects/${currentId}/publish`, { method: 'POST' });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    if (j.status === 'published') {
      PUBLISHED = { hash: j.hash, commit: j.commit, updatedAt: new Date().toISOString() };
      currentHash = j.hash;
      $('#hash').title = `${j.hash} · 仓库已写回 ${String(j.commit).slice(0, 8)}`;
      toast(`已写回 ${j.changed} 个文件 · commit ${String(j.commit).slice(0, 8)}`);
    } else {
      toast('远端已经是最新，无需写回');
    }
  } catch (err) {
    toast('写回失败：' + err.message);
  } finally {
    b.disabled = false;
    b.textContent = old;
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
  document.querySelectorAll('#page-nav button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.page) === page);
  });
}

function canScrollWithin(target, dy) {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2) {
      if (dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 2) return true;
      if (dy < 0 && el.scrollTop > 2) return true;
    }
    el = el.parentElement;
  }
  return false;
}

function initPager() {
  const dash = $('#dashboard');
  const nav = $('#page-nav');
  if (!dash || !nav) return;
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) goPage(Number(b.dataset.page));
  });
  let lock = 0;
  dash.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;
    if (!$('#modal-mask').hidden || !$('#drawer').hidden) return;
    const t = e.target;
    if (t instanceof Element && t.closest('input, textarea, select')) return;
    if (canScrollWithin(t, e.deltaY)) return;
    if (Math.abs(e.deltaY) < 4 && Math.abs(e.deltaX) < 4) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lock < 620) return;
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    const next = page + (delta > 0 ? 1 : -1);
    if (next < 0 || next >= PAGE_COUNT) return;
    lock = now;
    goPage(next);
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (dash.hidden) return;
    if (!$('#modal-mask').hidden || !$('#drawer').hidden) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
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
    auto.title = canWrite ? '每隔 10 分钟刷新并写回' : '每隔 10 分钟从仓库同步（只读）';
  }
}

function openPrNote() {
  if (!PROJECT || !currentId) return;
  if (!ROLE.isAdmin) {
    toast(`只读模式：PR 备注由管理员（${ROLE.admin || '未设置'}）发布`);
    return;
  }
  openModal('发 PR 备注', '把当前审计摘要（节点统计、关键路径、卡点）评论到指定 PR，带 PM 标识；同一指纹重复发会更新原评论。', (m) => {
    const pr = inputEl('text', '例如 2');
    field(m, 'PR 编号', pr, '只写评论，不改代码。');
    const msg = el('div');
    m.append(msg);
    actionsEl(m, [
      ['关闭', '', closeModal],
      ['发送', 'primary', async (e) => {
        const n = Number(pr.value.trim());
        if (!n) { msg.append(el('div', 'errbox', '先填 PR 编号')); return; }
        const btn = e.target;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/projects/${currentId}/pr-note`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pr: n }),
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          msg.innerHTML = '';
          msg.append(el('div', 'okbox', j.status === 'updated' ? `已更新 PR #${n} 的 PM 备注` : `已评论 PR #${n}`));
        } catch (err) {
          msg.innerHTML = '';
          msg.append(el('div', 'errbox', String(err.message)));
        } finally {
          btn.disabled = false;
        }
      }],
    ]);
  });
}

function openLinker(branch) {
  if (!PROJECT) return;
  const nodes = facts?.nodes || [];
  openModal(`归位：${branch}`, '选一个节点，PM 会在该分支的 open PR 上留一条关联证据；没有 open PR 时给出可照抄的命令。', (m) => {
    const hint = el('p', 'sub');
    m.append(hint);
    const list = el('div', 'list');
    for (const n of nodes) {
      const row = el('div', 'row');
      row.append(el('span', 'id', n.id), el('span', 't', n.title));
      row.append(el('span', 'tag', n.owner));
      const btn = el('button', 'mini', '选这个');
      btn.onclick = () => linkBranch(branch, n.id, hint);
      row.append(btn);
      list.append(row);
    }
    m.append(list);
    actionsEl(m, [['关闭', '', closeModal]]);
  });
}

async function linkBranch(branch, node, hint) {
  try {
    const res = await fetch(`/api/projects/${PROJECT.id}/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, node }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
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
        run.disabled = true;
        try {
          const r2 = await fetch(`/api/projects/${PROJECT.id}/link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branch, node, run: true }),
          });
          const j2 = await r2.json();
          if (!r2.ok) throw new Error(j2.error || `HTTP ${r2.status}`);
          toast(`已归位到 PR #${j2.pr}（节点 ${node}）`);
          closeModal();
        } catch (err) {
          toast('归位失败：' + err.message);
        } finally {
          run.disabled = false;
        }
      };
      row.append(run);
    }
    hint.append(row);
  } catch (err) {
    hint.textContent = '归位失败：' + err.message;
  }
}

function openIdentity() {
  if (!PROJECT) return;
  const members = PROJECT.members || {};
  openModal('本机身份', 'PM 靠 gh 登录名和 git 邮箱认人。对不上成员时，在这里把它绑到某个成员。', (m) => {
    const id = IDENTITY?.login || IDENTITY?.email || '（没读到）';
    m.append(el('p', 'agent-identity', `当前识别：${id}${IDENTITY?.memberId ? ` → ${IDENTITY.memberId}` : ''}`));
    const list = el('div', 'list');
    for (const [mid, mem] of Object.entries(members)) {
      const row = el('div', 'row');
      const picked = IDENTITY?.memberId === mid;
      row.append(el('span', 'id', mid), el('span', 't', `${mem.name || ''}｜github: ${mem.github || '未填'}`));
      const btn = el('button', 'mini', picked ? '当前' : '绑定');
      btn.disabled = picked;
      btn.onclick = () => bindIdentity(mid, mem.github || (IDENTITY?.login ?? ''));
      row.append(btn);
      list.append(row);
    }
    m.append(list);
    const gh = inputEl('text', 'GitHub 登录名', IDENTITY?.login || '');
    field(m, '这个成员的 GitHub 登录名', gh, '写进 projects/<id>/project.json 的 members，只影响本机身份映射。');
    actionsEl(m, [
      ['关闭', '', closeModal],
      ['保存并重新识别', 'primary', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/projects/${PROJECT.id}/identity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memberId: IDENTITY?.memberId || Object.keys(members)[0], github: gh.value.trim() }),
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
          toast(`已绑定：${j.label}`);
          closeModal();
          await openProject(PROJECT.id, { sync: false });
        } catch (err) {
          toast('绑定失败：' + err.message);
        } finally {
          btn.disabled = false;
        }
      }],
    ]);
  });
}

async function bindIdentity(memberId, github) {
  if (!github) { toast('先填 GitHub 登录名'); return; }
  try {
    const res = await fetch(`/api/projects/${PROJECT.id}/identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId, github }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    toast(`已绑定：${j.label}`);
    closeModal();
    await openProject(PROJECT.id, { sync: false });
  } catch (err) {
    toast('绑定失败：' + err.message);
  }
}

function renderStats() {
  const s = facts.stats;
  const items = [
    ['完成', s.done, `${s.done}/${s.nodes}`],
    ['进行中', s.active, ''],
    ['停滞', s.stale, ''],
    ['被阻塞', s.blocked, ''],
    ['待启动', s.ready, ''],
    ['issue 覆盖', `${s.withIssues}/${s.nodes}`, `${Math.round((s.issueCoverage || 0) * 100)}%`],
  ];
  const box = $('#stats');
  box.innerHTML = '';
  for (const [k, v, sub] of items) {
    const d = el('div', 'stat');
    d.append(el('div', 'k', k), el('div', 'v', String(v)));
    if (sub) d.append(el('div', 's', sub));
    box.append(d);
  }
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
  bar.style.background = '#ffb457';
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
  const MAX_PER_ROW = Math.max(3, Math.min(8, Math.floor((width - PAD * 2 + GX) / (W + GX))));
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
  if (box) box.classList.toggle('scroll-y', box.clientHeight > 0 && height > box.clientHeight + 2);

  const defs = sel('defs', {});
  const marker = sel('marker', {
    id: 'arrow', viewBox: '0 0 8 8', refX: 7, refY: 4,
    markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
  });
  marker.append(sel('path', { d: 'M0,0 L8,4 L0,8 z', fill: '#3c5060' }));
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
        stroke: '#ffb457', 'stroke-width': 3, 'stroke-linecap': 'round',
      }));
    }
    if (IDENTITY?.memberId && n.owner === IDENTITY.memberId) {
      lift.append(sel('circle', { cx: W - 8, cy: 9, r: 2.4, fill: '#3ddbe8' }));
    }
    const l1 = sel('text', { x: 12, y: 19, 'font-size': 11, fill: '#7d93a8', 'font-family': 'ui-monospace, Consolas, monospace' });
    l1.textContent = `${n.id} · ${n.owner} · ${LABEL[n.state]}`;
    const l2 = sel('text', { x: 12, y: 37, 'font-size': 12.5, fill: TEXT2 });
    l2.textContent = truncate(n.title, 11);
    lift.append(l1, l2);

    g.addEventListener('mouseenter', () => {
      svg.querySelectorAll('.edge').forEach((e) => {
        e.classList.toggle('dim', e.dataset.from !== n.id && e.dataset.to !== n.id);
      });
      nodeLayer.append(g);
      g.classList.add('hot');
      showPeek(n, g);
    });
    g.addEventListener('mouseleave', () => {
      svg.querySelectorAll('.edge').forEach((e) => e.classList.remove('dim'));
      g.classList.remove('hot');
      hidePeek();
    });
    g.addEventListener('click', () => {
      hidePeek();
      openDrawer(n);
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
  box.append(el('div', 'pk-hint', '点击打开完整简报'));
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
  table.append(head);
  for (const id of cp.path) {
    const n = byId.get(id);
    const tr = el('tr');
    tr.append(el('td', 'mono', id), el('td', '', n.owner));
    const td = el('td');
    td.append(stateChip(n.state));
    tr.append(td, el('td', 'num', n.daysIdle == null ? '—' : `${n.daysIdle} 天`), el('td', 'num', String(n.downstream)));
    table.append(tr);
  }
  const tblWrap = el('div', 'tbl-wrap');
  tblWrap.append(table);
  box.append(tblWrap, el('p', 'sub', `剩余 ${cp.len} 人日（T 恤码估算，不是承诺）`));
}

async function renderBlockers() {
  const box = $('#blockers');
  if (!box || !facts || !currentId) return;
  if (ALERTS && ALERTS.id === currentId && ALERTS.hash === currentHash) {
    paintAlerts(ALERTS.data);
    return;
  }
  const id = currentId;
  box.innerHTML = '';
  box.append(el('p', 'sub', '正在生成催办清单…'));
  try {
    const res = await fetch(`/api/projects/${id}/alerts?t=` + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (currentId !== id) return;
    ALERTS = { id, hash: currentHash, data };
    paintAlerts(data);
  } catch (err) {
    box.innerHTML = '';
    box.append(el('p', 'sub', '催办清单不可用：' + err.message));
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
    const list = el('div', 'list alerts-list');
    for (const a of alerts) {
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
    }
    box.append(list);
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
  if (TRAIL && TRAIL.id === currentId && TRAIL.hash === currentHash) {
    paintTrail(TRAIL.data);
    return;
  }
  const id = currentId;
  box.innerHTML = '';
  box.append(el('p', 'sub', '正在重算指纹并生成证据链…'));
  try {
    const res = await fetch(`/api/projects/${id}/trail?t=` + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (currentId !== id) return;
    TRAIL = { id, hash: currentHash, data };
    paintTrail(data);
  } catch (err) {
    box.innerHTML = '';
    box.append(el('p', 'sub', '证据链不可用：' + err.message));
  }
}

function paintTrail(data) {
  const chip = $('#trail-verify');
  const v = data.verify || {};
  chip.textContent = v.ok ? '指纹重算一致 ✓' : '指纹不一致 ✗';
  chip.className = 'chip ' + (v.ok ? 'ok' : 'readonly');
  chip.title = v.ok
    ? `${data.trail.hash}\n从包内证据重新推导，与包内指纹一致`
    : `包内 ${v.expected || '?'}\n重算 ${v.actual || '?'}${v.error ? '\n' + v.error : ''}`;
  const box = $('#trail');
  box.innerHTML = '';
  const t = data.trail;
  const link = (text, href, cls) => {
    const a = el('a', cls || '', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  };
  const prRow = (p) => {
    const row = el('div', 'trail-pr');
    row.append(link(`PR #${p.number}`, p.url, 'mono'));
    row.append(el('span', '', p.merged_at ? `合并于 ${fmtDay(p.merged_at)}` : p.state === 'open' ? '开放中' : p.state));
    if (p.head_ref) row.append(el('span', 'mono dim', `${p.head_ref}${p.base_ref ? ` → ${p.base_ref}` : ''}`));
    if (p.additions != null) row.append(el('span', 'mono dim', `+${p.additions}/-${p.deletions} · ${p.changed_files} 文件`));
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
  box.append(el('h3', 'trail-head', `已完成（${done.length}）——每个节点都能追到合并 PR 与证据文件`));
  if (!done.length) box.append(el('p', 'sub', '还没有节点完成。'));
  for (const n of done) box.append(nodeCard(n));

  const working = t.nodes.filter((n) => n.state === 'active' || n.state === 'stale');
  box.append(el('h3', 'trail-head', `进行中 / 停滞（${working.length}）`));
  if (!working.length) box.append(el('p', 'sub', '无。'));
  for (const n of working) box.append(nodeCard(n));

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
  loadAgent()
    .then((a) => {
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
          const text = await fetchNodeMd(n.id);
          const ok = await copyText(text, `${n.id}.brief.md`);
          toast(ok ? `已复制 ${n.id} 简报` : '剪贴板不可用，已改为下载简报 md');
        } catch (err) {
          toast('复制失败：' + err.message);
        }
      };
      const open = el('button', 'btn ghost', '看完整简报');
      open.onclick = openAgentModal;
      acts.append(copy, open);
      agentSec.append(acts);
      agentSec.append(el('p', 'sub', `写回仓库后位于 ${node.markdownPath}`));
    })
    .catch((err) => {
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

async function loadAgent(force = false) {
  if (AGENT && !force) return AGENT;
  const res = await fetch(`/api/projects/${currentId}/agent?t=` + Date.now());
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${res.status}`);
  }
  AGENT = await res.json();
  return AGENT;
}

async function fetchNodeMd(nodeId) {
  const res = await fetch(`/api/projects/${currentId}/agent/${nodeId}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function openAgentModal() {
  openModal('Agent 简报', '节点任务与 GitHub 证据深绑：同一份简报既能给人看，也能直接喂给 agent。', (m) => {
    const body = el('div');
    body.append(el('p', 'sub', '正在生成…'));
    m.append(body);
    loadAgent()
      .then((a) => {
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
        body.append(el('h4', '', '写回仓库后的位置'));
        const ul = el('ul');
        for (const p of [
          `.pm/${PROJECT.id}/manifest.json`,
          `.pm/${PROJECT.id}/bundle.parts/*.b64`,
          `.pm/${PROJECT.id}/AGENT.md`,
          `.pm/${PROJECT.id}/agent/index.json`,
          `.pm/${PROJECT.id}/agent/tasks/<节点>.md`,
          `.pm/${PROJECT.id}/interpretations/<提交>.md`,
        ]) ul.append(el('li', 'mono', p));
        body.append(ul);

        const acts = el('div', 'actions');
        const dlIndex = el('button', 'btn', '下载 index.json');
        dlIndex.onclick = () => downloadText(`${PROJECT.id}.agent.index.json`, JSON.stringify(a, null, 2));
        const dlMd = el('button', 'btn primary', '下载全部节点 md');
        dlMd.onclick = async () => {
          try {
            const parts = [];
            for (const n of a.nodes) parts.push(await fetchNodeMd(n.id));
            downloadText(`${PROJECT.id}.agent.tasks.md`, parts.join('\n\n---\n\n'));
          } catch (err) {
            toast('导出失败：' + err.message);
          }
        };
        const dlGuide = el('button', 'btn', '下载生产指导');
        dlGuide.onclick = () => downloadText(`${PROJECT.id}.AGENT.md`, a.guide || '');
        const copyOnboard = el('button', 'btn', '复制接入提示词');
        copyOnboard.title = '任何 agent 通用：整段粘进会话即可按 PM 协议开工';
        copyOnboard.onclick = async () => {
          try {
            const res = await fetch(`/api/projects/${currentId}/onboarding?t=` + Date.now());
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            const ok = await copyText(j.text, `${currentId}.onboarding.md`);
            toast(ok ? '接入提示词已复制，整段粘进 agent 会话' : '剪贴板不可用，已改为下载 onboarding.md');
          } catch (err) {
            toast('复制失败：' + err.message);
          }
        };
        const close = el('button', 'btn ghost', '关闭');
        close.onclick = closeModal;
        acts.append(close, dlIndex, dlGuide, copyOnboard, dlMd);
        body.append(acts);
      })
      .catch((err) => {
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

async function copyText(text, fallbackName) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    downloadText(fallbackName, text);
    return false;
  }
}

function closeDrawer() {
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
    box.append(
      el(
        'div',
        'chat-empty',
        chatMode === 'beginner'
          ? '用大白话问：现在真正卡在哪里、我今天该做什么。PM 会把术语拆开讲。'
          : '问进度、问取舍、问卡点根因。PM 会引用节点号、分支和证据。',
      ),
    );
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
  if (!q || streaming || !currentId || !facts) return;
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
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
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
    streaming = false;
    $('#send').disabled = false;
  }
}

/* ---------- 空状态 ---------- */

function showWelcome(project) {
  $('#dashboard').hidden = true;
  const w = $('#welcome');
  w.hidden = false;
  w.innerHTML = '';
  if (project) {
    w.append(el('h2', '', `还没有「${project.name}」的审计数据`));
    w.append(el('p', '', `仓库 ${project.repo}。点「拉取数据」会读远程仓库的提交、分支和 PR，生成第一份数据包。`));
    const actions = el('div', 'welcome-actions');
    const b = el('button', 'btn primary', '拉取数据');
    b.onclick = () => pullData(project.id, b);
    const ex = el('button', 'btn', '导入数据包');
    ex.onclick = openImport;
    actions.append(b, ex);
    w.append(actions);
    w.append(el('p', 'muted', '拉取需要本机已登录 gh（gh auth status 能通过）。'));
  } else {
    w.append(el('h2', '', '还没有项目数据'));
    w.append(el('p', '', '两种方式开始：'));
    const ol = el('ol');
    const li1 = el('li');
    li1.append(el('b', '', '导入数据包'), document.createTextNode('：拿到别人导出的 .bundle.pm.json，导入后用包内计划与证据重算指纹，一致才接收。'));
    const li2 = el('li');
    li2.append(el('b', '', '新建项目'), document.createTextNode('：填仓库和任务计划 JSON，再拉一次 GitHub 数据。'));
    ol.append(li1, li2);
    w.append(ol);
    w.append(el('p', 'muted', '数据格式 pm-audit/bundle v1：计划 + 证据 + 冻结时刻 asOf + SHA-256 指纹。同一份包在任何机器上重算结果相同。'));
    const actions = el('div', 'welcome-actions');
    const b1 = el('button', 'btn primary', '导入数据包');
    b1.onclick = openImport;
    const b2 = el('button', 'btn', '新建项目');
    b2.onclick = openNewProject;
    actions.append(b1, b2);
    w.append(actions);
  }
  $('#pname').textContent = project ? project.name : 'PM 审计台';
  $('#repo').textContent = project ? project.repo : '';
  $('#fetched').textContent = '';
  $('#hash').textContent = '';
  $('#hash').title = '';
  $('#who').textContent = '';
  document.title = 'PM 审计台';
}

/* ---------- 拉取 / 刷新 ---------- */

async function pullData(id, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '拉取中…（1–2 分钟）';
  try {
    const res = await fetch(`/api/projects/${id}/refresh`, { method: 'POST' });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    AGENT = null;
    await loadProjects();
    await openProject(id, { sync: false });
  } catch (err) {
    console.error(err);
    btn.textContent = '失败，看提示';
    toast('拉取失败：' + err.message);
  } finally {
    btn.disabled = false;
    setTimeout(() => {
      btn.textContent = old;
    }, 2000);
  }
}

/* ---------- 弹窗基础 ---------- */

function openModal(title, sub, build) {
  const m = $('#modal');
  m.innerHTML = '';
  m.append(el('h3', '', title));
  if (sub) m.append(el('p', 'sub', sub));
  build(m);
  $('#modal-mask').hidden = false;
}

function closeModal() {
  $('#modal-mask').hidden = true;
  $('#modal').innerHTML = '';
}

function field(parent, label, input, tip) {
  const l = el('label', '', label);
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
  const s = $('#model');
  s.textContent = settings.model || 'LongCat-2.5';
  $('#side-status').textContent = settings.hasKey
    ? `模型 ${settings.model} · key 尾号 ${settings.hint}`
    : '还没有配置 API key';
}

function openSettings() {
  openModal('API 设置', '每个人配自己的 API key。key 只写本机 pm-audit/.env，不进前端、不进数据包。', (m) => {
    const key = inputEl('password', settings.hasKey ? `已配置，尾号 ${settings.hint}；留空不修改` : 'sk-...');
    field(m, 'LongCat API Key', key, '在 api.longcat.chat 控制台创建。也支持任意 OpenAI 兼容服务，改 .env 里的 LONGCAT_BASE。');
    const model = inputEl('text', 'LongCat-2.5', settings.model || 'LongCat-2.5');
    field(m, '模型', model, '默认 LongCat-2.5；换服务时填对应的模型名。');
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
            const body = { model: model.value.trim() || 'LongCat-2.5' };
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
            msg.append(el('div', 'okbox', j.hasKey ? `已保存。模型 ${j.model}，key 尾号 ${j.hint}。` : '已保存，但还没有 key。'));
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

/* ---------- 新建项目 ---------- */

function openNewProject() {
  openModal('新建项目', '需要一份任务计划 JSON：选文件，或让模型从仓库文档拆一份草稿再人工核对。建好后点「拉取数据」读 GitHub。', (m) => {
    const id = inputEl('text', 'my-project');
    field(m, '项目 id（小写字母/数字/连字符）', id, '只用于目录名，例如 my-project。');
    const name = inputEl('text', '我的项目');
    field(m, '显示名称', name);
    const repo = inputEl('text', 'owner/name');
    field(m, 'GitHub 仓库', repo, '例如 owner/name。私有仓库需要本机 gh 已登录。');
    const local = inputEl('text', '本地仓库绝对路径（可留空）');
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
    sec('数据包在仓库里', '刷新后指纹变化会自动写回 <code>.pm/&lt;项目&gt;/</code>（bundle、manifest、每个节点的 Agent 简报）。别人打开 PM 时会先读 manifest，发现有更新就自动拉取并校验；手动入口是右上「同步」「写回」。');
    sec('谁能改数据', '管理员 = <code>project.json</code> 的 <code>admin</code>、<code>admins[]</code>，以及所有已绑定 <code>members[].github</code> 的成员；未绑定登录名的成员仍是只读。写回、PR 备注、归位执行只对管理员开放，同步时也会校验远端 <code>.pm/</code> 最后一次提交作者是否在管理员列表里。');
    sec('只有一个进度文件', '进度数据只落一份：仓库里固定为 <code>.pm/&lt;项目&gt;/</code> 的 bundle + manifest + Agent 简报，不按人分文件；写回会整树覆盖并删除旧分片。若远端数据包比本地新，写回返回 409 并提示先同步或刷新，避免用旧快照覆盖唯一的进度文件。');
    sec('只读用户能做什么', '照样看审计图、卡点、关键路径、问对话、导出数据包；能拿到归位命令并复制给管理员执行。要改进度数据，请先把 GitHub 登录名绑到成员上，再由本人刷新并写回。');
    sec('两种对话', '「小白」挡讲人话，直奔下一步；「进阶」挡给结论、证据和取舍。两种都会先标出你的身份和负责的节点。');
    sec('给 Agent 的简报', '点对话卡片的「Agent 简报」或节点详情里的「复制节点简报 md」。生产指导在 <code>.pm/&lt;项目&gt;/AGENT.md</code>，节点简报绑验收、依赖、证据和下一步，位于 <code>.pm/&lt;项目&gt;/agent/</code>。');
    sec('本机身份', 'PM 用 <code>gh api user</code> 和 <code>git config user.email</code> 识别你是谁，映射到项目的 members[].github；识别不到就只显示账号，不影响审计。');
    sec('分享给别人', '点右上「导出」得到 <code>.bundle.pm.json</code>。对方导入后会用包内计划和证据重算 SHA-256 指纹，一致才接收；不一致可以强制导入，但会标出来。');
    sec('API key', '每人配自己的 key，只写本机 .env。key 不会出现在前端代码、导出包或仓库里。');
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

$('#btn-new').onclick = openNewProject;
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

$('#refresh').onclick = async () => {
  if (!currentId) return;
  const b = $('#refresh');
  if (!PROJECT) return;
  b.disabled = true;
  b.textContent = ROLE.isAdmin ? '刷新中…（1–2 分钟）' : '同步中…';
  try {
    const res = await fetch(`/api/projects/${currentId}/refresh`, { method: 'POST' });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    AGENT = null;
    await loadProjects();
    await openProject(currentId, { sync: false });
    if (j.readOnly) {
      const st = j.sync?.status;
      if (st === 'updated') toast(`只读模式：已从仓库同步 ${String(j.hash).slice(7, 15)}`);
      else if (st === 'untrusted') toast(`只读：远端数据包作者 ${j.sync.author || '未知'} 不是管理员，已拒绝加载`);
      else if (st === 'absent') toast('只读：仓库里还没有 PM 数据包');
      else if (st === 'invalid') toast('只读：远端数据包校验失败，已忽略');
      else toast('只读模式：已是最新数据');
      b.textContent = '已同步';
      return;
    }
    if (j.publish?.status === 'published') {
      toast(`已写回仓库：${j.publish.changed} 个文件 · ${String(j.publish.commit).slice(0, 8)}`);
    } else if (j.publish?.status === 'error') {
      toast('刷新成功，但写回失败：' + j.publish.error);
    } else if (j.publish?.status === 'same') {
      toast('数据没变化，未写回');
    }
    if (j.interpreted?.comments?.length) {
      const c = j.interpreted.comments.filter((x) => x.status === 'posted' || x.status === 'updated');
      if (c.length) toast(`已解读新提交并评论 ${c.length} 个 PR`);
    }
    b.textContent = '已更新';
  } catch (err) {
    console.error(err);
    b.textContent = '刷新失败';
    toast('刷新失败：' + err.message);
  } finally {
    b.disabled = false;
    setTimeout(() => {
      b.textContent = '刷新数据';
    }, 1800);
  }
};

let autoTimer = 0;
function setAuto(on) {
  localStorage.setItem('pm.auto', on ? '1' : '0');
  const b = $('#btn-auto');
  b.classList.toggle('on', on);
  b.title = on ? '自动刷新已开：每 10 分钟刷新并写回' : '每隔 10 分钟自动刷新并写回';
  clearInterval(autoTimer);
  if (on) autoTimer = setInterval(() => { if (currentId && !document.hidden) $('#refresh').click(); }, 10 * 60 * 1000);
}
$('#btn-auto').onclick = () => setAuto(localStorage.getItem('pm.auto') !== '1');
$('#btn-prnote').onclick = openPrNote;
$('#btn-trail-md').onclick = () => {
  if (!TRAIL?.data?.markdown) return toast('证据链还没加载好，稍后再试');
  downloadText(`${currentId}.trail.md`, TRAIL.data.markdown);
};
initPager();

$('#export').onclick = () => {
  if (!currentId) return;
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
  if (pick) await openProject(pick.id);
  else showWelcome(null);
  const deepPage = Number(new URLSearchParams(location.search).get('page'));
  if (Number.isInteger(deepPage) && deepPage >= 0 && deepPage < PAGE_COUNT) goPage(deepPage);
})();
