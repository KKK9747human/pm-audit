// PM 审计台 · 前端「立项向导」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

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

      const idInput = inputEl('text', 'my-project', state.id);
      idInput.oninput = () => { state.id = idInput.value; };
      field(cell(grid), '项目 id *', idInput, '小写字母、数字和连字符，例如 my-project。只用于目录名。');

      const nameInput = inputEl('text', '我的项目', state.name);
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
    const id = inputEl('text', 'my-project');
    field(m, '项目 id（小写字母/数字/连字符）', id, '只用于目录名，例如 my-project。');
    const name = inputEl('text', '我的项目');
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
