// PM 审计台 · 前端「空状态」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

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
