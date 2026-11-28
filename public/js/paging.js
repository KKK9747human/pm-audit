// PM 审计台 · 前端「分页」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

/* ---------- 分页 ---------- */

const PAGE_COUNT = 4;
let page = 0;

function goPage(n) {
  page = Math.max(0, Math.min(PAGE_COUNT - 1, n));
  hidePeek();
  const track = $('#pages');
  if (track) track.style.transform = `translateY(-${page * 100}%)`;
  document.querySelectorAll('#page-tabs button').forEach((b) => {
    const active = Number(b.dataset.page) === page;
    b.classList.toggle('on', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('#pages > .page').forEach((section, i) => {
    section.inert = i !== page;
    section.setAttribute('aria-hidden', String(i !== page));
  });
  if (page === 3) renderChat(currentId);
}

function initPager() {
  const dash = $('#dashboard');
  const nav = $('#page-tabs');
  if (!dash || !nav) return;
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) goPage(Number(b.dataset.page));
  });
  document.addEventListener('keydown', (e) => {
    if (dash.hidden) return;
    if (!$('#modal-mask').hidden || !$('#drawer').hidden) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (window.matchMedia('(max-width: 900px)').matches && !document.activeElement?.closest('#page-tabs')) return;
    if (e.key === 'PageDown' || e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      goPage(page + 1);
    } else if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      goPage(page - 1);
    }
  });
}
