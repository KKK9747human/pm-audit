// PM 审计台 · 前端「弹窗基础」
// 拆分自原 public/app.js；加载顺序由 public/index.html 决定。

/* ---------- 弹窗基础 ---------- */

function openModal(title, sub, build, { wide = false } = {}) {
  ++modalGeneration;
  const m = $('#modal');
  m.innerHTML = '';
  m.classList.toggle('wide', wide);
  m.append(el('h3', '', title));
  if (sub) m.append(el('p', 'sub', sub));
  build(m);
  $('#modal-mask').hidden = false;
}

function closeModal() {
  ++modalGeneration;
  $('#modal-mask').hidden = true;
  const m = $('#modal');
  m.innerHTML = '';
  m.classList.remove('wide');
}

let fieldSequence = 0;
function field(parent, label, input, tip) {
  const l = el('label', '', label);
  if (!input.id) input.id = `field-${++fieldSequence}`;
  l.htmlFor = input.id;
  parent.append(l, input);
  if (tip) parent.append(el('div', 'tip', tip));
  return input;
}

function inputEl(type, placeholder, value) {
  const i = el('input');
  i.type = type;
  i.placeholder = placeholder || '';
  if (value != null) i.value = value;
  return i;
}

function actionsEl(parent, buttons) {
  const a = el('div', 'actions');
  for (const [label, cls, fn] of buttons) {
    const b = el('button', 'btn ' + (cls || ''), label);
    b.onclick = fn;
    a.append(b);
  }
  parent.append(a);
  return a;
}

function toast(text) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = el('div', 'toast');
    document.body.append(t);
  }
  t.textContent = text;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.remove(), 3200);
}
