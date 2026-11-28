// PM 审计台 · 前端「侧栏 / 项目」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

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
