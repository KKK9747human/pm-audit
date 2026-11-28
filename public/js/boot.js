// PM 审计台 · 前端「启动」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

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
