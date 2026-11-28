// PM 审计台 · 前端「主界面总览」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

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
