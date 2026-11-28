// PM 审计台 · 前端「拉取数据」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

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
