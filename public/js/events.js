// PM 审计台 · 前端「事件绑定」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

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

$('#btn-new').onclick = openIntakeWizard;
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

async function refreshData({ auto = false } = {}) {
  const ctx = projectContext();
  if (!beginProjectAction(ctx)) return;
  try {
    const res = await withActionTimeout(fetch(`/api/projects/${ctx.id}/refresh${auto ? '?auto=1' : ''}`, { method: 'POST' }), '刷新');
    const j = await res.json();
    if (!isCurrent(ctx)) return;
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    if (j.skipped) {
      if (!auto) toast(`未刷新：${j.reason || '远端无变化'}`);
      return;
    }
    if (j.readOnly) {
      const st = j.sync?.status;
      if (!auto) {
        if (st === 'updated') toast(`只读模式：已从仓库同步 ${String(j.hash).slice(7, 15)}`);
        else if (st === 'untrusted') toast(`只读：远端数据包作者 ${j.sync.author || '未知'} 不是管理员，已拒绝加载`);
        else if (st === 'absent') toast('只读：仓库里还没有 PM 数据包');
        else if (st === 'invalid') toast('只读：远端数据包校验失败，已忽略');
        else toast('只读模式：已是最新数据');
      }
    } else {
      if (j.publish?.status === 'published') {
        toast(`已写回仓库：${j.publish.changed} 个文件 · ${String(j.publish.commit).slice(0, 8)}`);
      } else if (j.publish?.status === 'error') {
        toast('刷新成功，但写回失败：' + j.publish.error);
      } else if (j.publish?.status === 'local-only' && !auto) {
        toast('已刷新本地数据，远端无变化，未写回');
      }
      if (j.interpreted?.comments?.length) {
        const c = j.interpreted.comments.filter((x) => x.status === 'posted' || x.status === 'updated');
        if (c.length) toast(`已解读新提交并评论 ${c.length} 个 PR`);
      }
    }
    await reloadProject(ctx);
  } catch (err) {
    if (isCurrent(ctx) && !auto) toast('刷新失败：' + err.message);
  } finally {
    finishProjectAction(ctx);
  }
}
$('#refresh').onclick = () => refreshData();

let autoTimer = 0;
function setAuto(on) {
  localStorage.setItem('pm.auto', on ? '1' : '0');
  const b = $('#btn-auto');
  b.classList.toggle('on', on);
  b.title = on ? '自动已开：每 10 分钟检查远端，有变化才刷新并写回' : '每 10 分钟检查远端，有变化才刷新并写回';
  clearInterval(autoTimer);
  if (on) autoTimer = setInterval(() => { if (currentId && !document.hidden) refreshData({ auto: true }); }, 10 * 60 * 1000);
}
$('#btn-auto').onclick = () => setAuto(localStorage.getItem('pm.auto') !== '1');
$('#btn-prnote').onclick = openPrNote;
$('#btn-trail-md').onclick = () => {
  if (!TRAIL?.data?.markdown || !isCurrent(TRAIL)) return toast('证据链还没加载好，稍后再试');
  downloadText(`${currentId}.trail.md`, TRAIL.data.markdown);
};
initPager();
initGraphPan();

$('#export').onclick = () => {
  if (!currentId || !facts || projectLoading) return;
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
