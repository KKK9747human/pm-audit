// PM 审计台 · 前端「导入弹窗」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

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
