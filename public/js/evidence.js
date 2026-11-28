// PM 审计台 · 前端「节点抽屉 / 证据链 / Agent 简报」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

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
