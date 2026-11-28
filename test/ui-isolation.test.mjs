import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
// 前端已按职责拆成 public/js/*.js，加载顺序由 index.html 声明；这里按同样顺序拼回一份脚本再喂给 vm。
const scriptSrcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
assert.ok(scriptSrcs.length > 1, 'index.html 应按顺序声明多个前端脚本');
const app = scriptSrcs
  .map((src) => readFileSync(new URL(`../public${src.split('?')[0]}`, import.meta.url), 'utf8'))
  .join('\n;\n');
const source = app.slice(0, app.indexOf('(async function boot()'));
assert.ok(source.length > 1000 && source.length < app.length);

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.clientWidth = 760;
    this.clientHeight = 300;
    this.scrollHeight = 300;
    this.scrollTop = 0;
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, on = !this.classList.contains(name)) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (on) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
      },
      add: (name) => this.classList.toggle(name, true),
      remove: (name) => this.classList.toggle(name, false),
    };
  }
  set textContent(value) { this.replaceChildren(); this.text = String(value ?? ''); }
  get textContent() { return (this.text || '') + this.children.map((x) => x.textContent).join(''); }
  set innerHTML(value) { this.textContent = value; }
  get innerHTML() { return this.textContent; }
  append(...children) {
    for (let child of children) {
      if (typeof child === 'string') { const text = new Element('text'); text.textContent = child; child = text; }
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  prepend(child) { this.append(child); this.children.unshift(this.children.pop()); }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.text = '';
    this.append(...children);
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((x) => x !== this);
    this.parentElement = null;
  }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'class') this.className = value;
    if (key === 'id') this.id = value;
  }
  removeAttribute(key) { delete this.attributes[key]; }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener() {}
  matches(selector) {
    if (selector === 'button[data-project-action]') return this.tagName === 'BUTTON' && this.dataset.projectAction != null;
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) || null;
  }
  querySelectorAll(selector) {
    const selectors = selector.replaceAll(' > ', ' ').split(/\s+/);
    const matches = (element) => {
      if (!element.matches(selectors.at(-1))) return false;
      let ancestor = element.parentElement;
      for (let i = selectors.length - 2; i >= 0; i--) {
        while (ancestor && !ancestor.matches(selectors[i])) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        ancestor = ancestor.parentElement;
      }
      return true;
    };
    const found = [];
    const walk = (element) => {
      for (const child of element.children) { if (matches(child)) found.push(child); walk(child); }
    };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get isConnected() { return this.tagName === 'BODY' || Boolean(this.parentElement?.isConnected); }
  focus() {}
  click() { if (!this.disabled) return this.onclick?.({ target: this, currentTarget: this }); }
}

function harness() {
  const body = new Element('body');
  const ids = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(match[1]);
    element.id = match[2];
    element.hidden = /\bhidden\b/.test(match[0]);
    ids.set(element.id, element);
    body.append(element);
  }
  const get = (id) => ids.get(id.replace(/^#/, ''));
  for (let i = 0; i < 4; i++) {
    const button = new Element('button'); button.dataset.page = String(i); get('page-tabs').append(button);
    const section = new Element('section'); section.className = 'page'; get('pages').append(section);
  }
  const requests = [];
  const notices = [];
  const downloads = [];
  const copied = [];
  const timers = [];
  const document = {
    body, hidden: false, activeElement: body,
    querySelector: (selector) => selector.startsWith('#') && !selector.includes(' ') ? get(selector) : body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    createElement: (tag) => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
    createTextNode: (text) => { const e = new Element('text'); e.textContent = text; return e; },
    addEventListener() {},
  };
  const ctx = vm.createContext({
    document, Element, console, URL, URLSearchParams, Blob, TextDecoder,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    location: { search: '', href: '' },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { clipboard: { writeText: async (text) => copied.push(text) } },
    getComputedStyle: () => ({ overflowY: 'auto' }),
    setTimeout: (fn, ms) => { const timer = { fn, ms, active: true }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.active = false; },
    setInterval: () => 1, clearInterval() {},
    fetch: (url, options = {}) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject, settled: false })),
    notices, downloads,
  });
  vm.runInContext(source, ctx, { filename: 'public/js/*.js' });
  vm.runInContext('toast = (text) => notices.push(text); downloadText = (name, text) => downloads.push({name, text});', ctx);
  const run = (code) => vm.runInContext(code, ctx);
  const pending = (path) => {
    const req = requests.find((r) => !r.settled && r.url.split('?')[0] === path);
    assert.ok(req, `missing offline request: ${path}`);
    return req;
  };
  const respond = (request, data, status = 200) => {
    request.settled = true;
    request.resolve({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => String(data) });
  };
  const reject = (request) => { request.settled = true; request.reject(new Error('offline failure')); };
  const fireTimers = (ms) => {
    for (const timer of timers) {
      if (timer.active && timer.ms <= ms) {
        timer.active = false;
        timer.fn();
      }
    }
  };
  const state = () => JSON.parse(run('JSON.stringify({ id: currentId, hash: currentHash, generation: projectGeneration, marker: facts?.marker, agent: AGENT?.data?.marker, trail: TRAIL?.data?.marker, alerts: ALERTS?.data?.marker, next: NEXT_ACTIONS?.data?.marker, history: BRIEF_HISTORY, published: PUBLISHED, loading: projectLoading, busy: projectBusy, autoSyncRunning, autoSyncReloadPending })'));
  const open = async (id, marker = id, admin = false) => {
    const promise = run(`openProject(${JSON.stringify(id)}, {sync:false})`);
    respond(requests.at(-1), bundle(id, marker, admin));
    await promise;
  };
  return { get, run, state, pending, respond, reject, open, requests, notices, downloads, copied, fireTimers };
}

function bundle(id, marker = id, admin = false) {
  return {
    project: { id, name: marker, repo: `offline/${id}`, members: {} },
    facts: { marker, asOf: '2026-11-20T00:00:00Z', nodes: [], people: {}, unlinked: [], criticalPath: { path: [], len: 0 }, stats: { nodes: 0, done: 0, active: 0, stale: 0, blocked: 0, ready: 0, withIssues: 0 } },
    hashes: { facts: `sha256:${marker}` }, isAdmin: admin, admin: 'maintainer', briefHistory: [{ hash: marker }],
  };
}
const trail = (marker, verify = { ok: true }) => ({ marker, trail: { hash: marker, nodes: [] }, verify, markdown: marker });
const agent = (marker, nodes = []) => ({ marker, asOf: '2026-11-20', hash: marker, stats: { nodes: nodes.length, done: 0 }, nodes });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const button = (element, label) => element.querySelectorAll('button').find((b) => b.textContent === label);

test('A slow / B fast cannot repaint or navigate back; loading clears derived state', async () => {
  const h = harness();
  await h.open('seed', 'seed', true);
  h.run('AGENT = TRAIL = ALERTS = NEXT_ACTIONS = {old: true}; PUBLISHED = {old:true};');
  const a = h.run('openProject("A", {sync:false, navigate:true})');
  const aRequest = h.pending('/api/projects/A');
  assert.equal(h.state().hash, null);
  assert.deepEqual(h.state().history, []);
  for (const name of ['AGENT', 'TRAIL', 'ALERTS', 'NEXT_ACTIONS', 'facts']) assert.equal(h.run(name), null);
  for (const id of ['refresh', 'btn-publish', 'btn-sync', 'btn-agent', 'export']) assert.equal(h.get(id).disabled, true);
  assert.match(h.get('welcome').textContent, /正在加载/);
  await h.open('B');
  h.run('goPage(3)');
  h.respond(aRequest, bundle('A'));
  await a;
  assert.equal(h.state().id, 'B');
  assert.equal(h.state().marker, 'B');
  assert.equal(h.run('page'), 3);
  assert.equal(h.get('btn-publish').disabled, true);
});

for (const outcome of ['success', 'error', '404']) test(`ABA project request ignores stale ${outcome}`, async () => {
  const h = harness();
  const old = h.run('openProject("A", {sync:false})');
  const request = h.pending('/api/projects/A');
  await h.open('B');
  await h.open('A', 'new-A');
  if (outcome === 'error') h.reject(request);
  else h.respond(request, bundle('A', 'old-A'), outcome === '404' ? 404 : 200);
  await old;
  assert.equal(h.state().marker, 'new-A');
  assert.equal(h.get('welcome').hidden, true);
  assert.equal(h.notices.length, 0);
});

test('project JSON body completion is also generation guarded', async () => {
  const h = harness();
  const old = h.run('openProject("A", {sync:false})');
  const req = h.pending('/api/projects/A');
  let resolveBody;
  req.settled = true;
  req.resolve({ ok: true, status: 200, json: () => new Promise((r) => { resolveBody = r; }) });
  await flush();
  await h.open('B');
  resolveBody(bundle('A'));
  await old;
  assert.equal(h.state().marker, 'B');
});

for (const endpoint of ['alerts', 'trail']) {
  for (const failure of [false, true]) test(`${endpoint} ignores ABA stale ${failure ? 'failure' : 'success'}`, async () => {
    const h = harness();
    await h.open('A', 'old');
    const old = h.pending(`/api/projects/A/${endpoint}`);
    await h.open('B');
    await h.open('A', 'new');
    const current = h.requests.filter((r) => !r.settled && r.url.split('?')[0] === `/api/projects/A/${endpoint}`).at(-1);
    h.respond(current, endpoint === 'trail' ? trail('new') : { marker: 'new', alerts: [], next: [] });
    await flush();
    if (failure) h.reject(old); else h.respond(old, endpoint === 'trail' ? trail('old') : { marker: 'old', alerts: [], next: [] });
    await flush();
    assert.equal(h.state()[endpoint], 'new');
    if (endpoint === 'alerts') assert.equal(h.state().next, 'new');
    assert.doesNotMatch(h.get(endpoint === 'alerts' ? 'blockers' : 'trail').textContent, /offline failure/);
  });
}

test('alerts and agent reject a changed hash even without a project switch', async () => {
  const h = harness();
  await h.open('A');
  const loading = h.run('loadAgent()');
  const result = assert.rejects(loading, { code: 'STALE_REQUEST' });
  h.run('currentHash = "sha256:new"');
  h.respond(h.pending('/api/projects/A/agent'), agent('old'));
  h.respond(h.pending('/api/projects/A/alerts'), { marker: 'old', alerts: [], next: [] });
  h.respond(h.pending('/api/projects/A/trail'), trail('old'));
  await result;
  await flush();
  assert.equal(h.state().agent, undefined);
  assert.equal(h.state().alerts, undefined);
  assert.equal(h.state().trail, undefined);
});

test('agent cache is keyed by project/hash and rejects superseded requests', async () => {
  const h = harness();
  await h.open('A');
  const first = h.run('loadAgent()');
  const rejected = assert.rejects(first, { code: 'STALE_REQUEST' });
  const firstRequest = h.pending('/api/projects/A/agent');
  const second = h.run('loadAgent(true)');
  const secondRequest = h.requests.at(-1);
  h.respond(secondRequest, agent('new'));
  assert.equal((await second).marker, 'new');
  h.respond(firstRequest, agent('old'));
  await rejected;
  assert.equal((await h.run('loadAgent()')).marker, 'new');
  await h.open('B');
  const b = h.run('loadAgent()');
  h.respond(h.pending('/api/projects/B/agent'), agent('B'));
  assert.equal((await b).marker, 'B');
});

for (const failure of [false, true]) test(`closed/reopened agent modal ignores stale ${failure ? 'error' : 'response'}`, async () => {
  const h = harness();
  await h.open('A');
  h.run('openAgentModal()');
  const old = h.pending('/api/projects/A/agent');
  h.run('closeModal(); openAgentModal()');
  const latest = h.requests.at(-1);
  h.respond(latest, agent('latest'));
  await flush();
  if (failure) h.reject(old); else h.respond(old, agent('old'));
  await flush();
  assert.equal(h.state().agent, 'latest');
  assert.doesNotMatch(h.get('modal').textContent, /简报生成失败/);
});

for (const failure of [false, true]) test(`drawer close/reopen ignores stale ${failure ? 'error' : 'agent'}`, async () => {
  const h = harness();
  await h.open('A');
  const node = (id) => ({ id, title: id, owner: 'one', state: 'ready', deps: [], blockedBy: [], prs: [], issues: [], commits: [], files: [] });
  await h.run(`openDrawer(${JSON.stringify(node('one'))})`);
  const old = h.pending('/api/projects/A/agent');
  h.run('closeDrawer()');
  await h.run(`openDrawer(${JSON.stringify(node('two'))})`);
  h.respond(h.requests.at(-1), agent('latest', [{ id: 'two', next: ['current instruction'], markdownPath: 'two.md' }]));
  await flush();
  if (failure) h.reject(old); else h.respond(old, agent('stale', [{ id: 'one', next: ['stale instruction'] }]));
  await flush();
  assert.match(h.get('drawer').textContent, /current instruction/);
  assert.doesNotMatch(h.get('drawer').textContent, /stale instruction|offline failure/);
  assert.equal(h.state().agent, 'latest');
});

test('closed markdown modal cannot download or request another project node', async () => {
  const h = harness();
  await h.open('A');
  h.run('openAgentModal()');
  h.respond(h.pending('/api/projects/A/agent'), agent('A', [{ id: 'one', title: 'one', next: [], state: 'ready' }, { id: 'two', title: 'two', next: [], state: 'ready' }]));
  await flush();
  const download = button(h.get('modal'), '下载全部节点 md').click();
  const old = h.pending('/api/projects/A/agent/one');
  h.run('closeModal(); openAgentModal()');
  h.respond(old, 'old markdown');
  await download;
  assert.equal(h.downloads.length, 0);
  assert.equal(h.requests.some((r) => r.url.endsWith('/agent/two')), false);
});

for (const action of ['autoSync("A")', 'syncNow()', 'refreshData()', 'refreshData({auto:true})', 'publishNow()', 'pullData("A", document.createElement("button"))']) {
  for (const failure of [false, true]) test(`${action} ignores stale ${failure ? 'error' : 'completion'} and preserves permissions`, async () => {
    const h = harness();
    await h.open('A', 'first', true);
    const actionPromise = h.run(action);
    const old = h.requests.at(-1);
    await h.open('B');
    await h.open('A', 'last', false);
    h.run('goPage(2)');
    const count = h.requests.length;
    if (failure) h.reject(old);
    else h.respond(old, { status: action.startsWith('publish') ? 'published' : 'updated', hash: 'sha256:stale', commit: 'old', changed: 2 });
    await actionPromise;
    assert.equal(h.state().marker, 'last');
    assert.equal(h.state().published, null);
    assert.equal(h.requests.length, count);
    assert.equal(h.run('page'), 2);
    assert.equal(h.get('btn-publish').disabled, true);
    assert.equal(h.get('btn-prnote').disabled, true);
    assert.equal(h.notices.length, 0);
  });
}

test('sync cannot commit a project list response or navigate after switching during reload', async () => {
  const h = harness();
  await h.open('A');
  const sync = h.run('syncNow()');
  h.respond(h.pending('/api/projects/A/sync'), { status: 'updated', hash: 'new' });
  await flush();
  const list = h.pending('/api/projects');
  await h.open('B');
  h.respond(list, [{ id: 'old-list', name: 'old' }]);
  await sync;
  assert.equal(h.state().id, 'B');
  assert.equal(h.run('projects.length'), 0);
});

test('current sync reload completes and restores only permitted actions', async () => {
  const h = harness();
  await h.open('A');
  h.run('goPage(3)');
  const sync = h.run('syncNow()');
  assert.equal(h.get('btn-sync').disabled, true);
  h.respond(h.pending('/api/projects/A/sync'), { status: 'updated', hash: 'new' });
  await flush();
  h.respond(h.pending('/api/projects'), [{ id: 'A', name: 'A', repo: 'offline/A' }]);
  await flush();
  h.respond(h.pending('/api/projects/A'), bundle('A', 'updated'));
  await sync;
  assert.equal(h.state().marker, 'updated');
  assert.equal(h.run('page'), 3);
  assert.equal(h.get('btn-sync').disabled, false);
  assert.equal(h.get('btn-publish').disabled, true);
});

test('background auto sync keeps project actions available while the remote request is pending', async () => {
  const h = harness();
  await h.open('A');
  const syncing = h.run('autoSync("A")');
  assert.equal(h.state().autoSyncRunning, true);
  assert.equal(h.state().busy, false);
  assert.equal(h.get('btn-sync').textContent, '同步');
  assert.equal(h.get('btn-sync').disabled, false);
  assert.equal(h.get('refresh').textContent, '刷新数据');
  assert.equal(h.get('refresh').disabled, false);
  h.respond(h.pending('/api/projects/A/sync'), { status: 'same', hash: 'sha256:A' });
  await syncing;
  assert.equal(h.state().autoSyncRunning, false);
  assert.equal(h.state().busy, false);
});

test('auto sync update does not interrupt an active chat', async () => {
  const h = harness();
  await h.open('A', 'old', true);
  h.run('streaming = true');
  const syncing = h.run('autoSync("A")');
  h.respond(h.pending('/api/projects/A/sync'), { status: 'updated', hash: 'sha256:new' });
  await syncing;
  assert.equal(h.state().marker, 'old');
  assert.equal(h.run('streaming'), true);
  assert.equal(h.state().autoSyncReloadPending, true);
  assert.equal(h.requests.some((request) => request.url.split('?')[0] === '/api/projects'), false);
});

test('auto sync update waits for a manual action and then reloads without clobbering it', async () => {
  const h = harness();
  await h.open('A', 'old', true);
  const syncing = h.run('autoSync("A")');
  const refresh = h.run('refreshData()');
  h.respond(h.pending('/api/projects/A/sync'), { status: 'updated', hash: 'sha256:new' });
  await syncing;
  assert.equal(h.state().marker, 'old');
  assert.equal(h.state().busy, true);
  assert.equal(h.state().autoSyncReloadPending, true);
  h.respond(h.pending('/api/projects/A/refresh'), { skipped: true, reason: 'test' });
  await refresh;
  h.respond(h.pending('/api/projects/A/sync'), { status: 'updated', hash: 'sha256:new' });
  await flush();
  h.respond(h.pending('/api/projects'), [{ id: 'A', name: 'A', repo: 'offline/A' }]);
  await flush();
  h.respond(h.pending('/api/projects/A'), bundle('A', 'new', true));
  await flush();
  assert.equal(h.state().marker, 'new');
  assert.equal(h.state().busy, false);
  assert.equal(h.get('btn-sync').textContent, '同步');
  assert.equal(h.get('refresh').textContent, '刷新数据');
});

test('current refresh reload restores actions after the data hash changes', async () => {
  const h = harness();
  await h.open('A', 'old', true);
  const refresh = h.run('refreshData()');
  assert.equal(h.get('refresh').textContent, '处理中…');
  h.respond(h.pending('/api/projects/A/refresh'), { hash: 'sha256:new', publish: { status: 'local-only' } });
  await flush();
  h.respond(h.pending('/api/projects'), [{ id: 'A', name: 'A', repo: 'offline/A' }]);
  await flush();
  h.respond(h.pending('/api/projects/A'), bundle('A', 'new', true));
  await refresh;
  assert.equal(h.state().marker, 'new');
  assert.equal(h.state().busy, false);
  assert.equal(h.get('btn-sync').textContent, '同步');
  assert.equal(h.get('btn-sync').disabled, false);
  assert.equal(h.get('refresh').textContent, '刷新数据');
  assert.equal(h.get('refresh').disabled, false);
});

for (const [action, label, timeout] of [
  ['autoSync("A")', '同步', 120000],
  ['syncNow()', '同步', 120000],
  ['refreshData()', '刷新', 120000],
  ['publishNow()', '写回', 180000],
  ['pullData("A", document.createElement("button"))', '拉取', 120000],
]) test(`${action} clears busy state when the request exceeds ${timeout}ms`, async () => {
  const h = harness();
  await h.open('A', 'old', true);
  const pendingAction = h.run(action);
  const request = h.requests.at(-1);
  h.fireTimers(timeout);
  await pendingAction;
  assert.equal(h.state().busy, false);
  assert.equal(h.state().autoSyncRunning, false);
  assert.equal(h.get('btn-sync').textContent, '同步');
  assert.equal(h.get('btn-sync').disabled, false);
  assert.equal(h.get('refresh').textContent, '刷新数据');
  assert.equal(h.get('refresh').disabled, false);
  if (!action.startsWith('autoSync')) assert.ok(h.notices.some((text) => text.includes(`${label}超时`)));
  h.respond(request, { status: 'same', hash: 'sha256:late' });
  await flush();
  assert.equal(h.state().marker, 'old');
  assert.equal(h.state().busy, false);
});

test('welcome preserves list identity/role metadata and empty members cannot submit', async () => {
  const h = harness();
  h.run('projects = [{id:"A",name:"A",repo:"offline/A",identity:{login:"alice"},isAdmin:false,admin:"maintainer",members:{}}]');
  const open = h.run('openProject("A", {sync:false})');
  h.respond(h.pending('/api/projects/A'), {}, 404);
  await open;
  assert.match(h.get('who').textContent, /alice/);
  assert.equal(h.get('who').disabled, false);
  assert.equal(h.get('btn-publish').disabled, true);
  assert.ok(button(h.get('welcome'), '绑定已有成员'));
  h.get('who').click();
  assert.match(h.get('modal').textContent, /projects\/A\/project.json/);
  assert.match(h.get('modal').textContent, /导入/);
  assert.equal(button(h.get('modal'), '保存并重新识别'), undefined);
});

test('identity requires explicit member selection and ignores response after reopening', async () => {
  const h = harness();
  await h.open('A');
  h.run('PROJECT.members = {one:{name:"One"},two:{name:"Two"}}; IDENTITY = {login:"alice",memberId:"one"}; openIdentity()');
  const modal = h.get('modal');
  const select = modal.querySelector('select');
  const save = button(modal, '保存并重新识别');
  assert.equal(select.value, '');
  assert.equal(save.disabled, true);
  select.value = 'two'; select.onchange();
  const saving = save.click();
  const request = h.pending('/api/projects/A/identity');
  assert.deepEqual(JSON.parse(request.options.body), { memberId: 'two', github: 'alice' });
  h.run('closeModal(); openIdentity()');
  const count = h.requests.length;
  h.respond(request, { label: 'stale binding' });
  await saving;
  assert.equal(h.requests.length, count);
  assert.equal(h.get('modal-mask').hidden, false);
  assert.equal(h.get('modal').querySelector('select').value, '');
  assert.equal(h.notices.length, 0);
});

test('trail distinguishes legacy, mismatch, verification error and self-consistency', () => {
  const h = harness();
  const cases = [
    [{ ok: true }, /指纹自洽/],
    [{ ok: false, code: 'LEGACY_BUNDLE' }, /旧版/],
    [{ ok: false, expected: 'old', actual: null, error: '数据包版本 1 已过期，请由管理员重新审计后再加载' }, /旧版/],
    [{ ok: false, expected: 'a', actual: 'b' }, /指纹不一致/],
    [{ ok: false, expected: 'a', actual: null, error: 'invalid evidence' }, /校验未完成/],
    [{}, /校验未完成/],
  ];
  for (const [verify, expected] of cases) {
    h.run(`paintTrail(${JSON.stringify(trail('hash', verify))})`);
    assert.match(h.get('trail-verify').textContent, expected);
  }
  h.run(`paintTrail(${JSON.stringify(trail('hash'))})`);
  assert.match(h.get('trail').textContent, /不证明证据真实/);
});

test('four-page transforms, inert pages and accessible narrow layout contracts remain intact', () => {
  const h = harness();
  h.run('goPage(3)');
  assert.equal(h.get('pages').style.transform, 'translateY(-300%)');
  assert.deepEqual(h.get('pages').children.map((p) => p.inert), [true, true, true, false]);
  assert.equal(h.get('page-tabs').children[3].getAttribute('aria-current'), 'page');
  assert.match(html, /<button[^>]*id="who"/);
  assert.equal((html.match(/id="page-tabs"/g) || []).length, 1);
  assert.deepEqual(
    [...html.matchAll(/<button data-page="(\d)"[^>]*>([^<]+)<\/button>/g)].map((m) => m[2]),
    ['流程', '进度', '证据链', '对话'],
  );
  assert.doesNotMatch(html + app, /bundle v1/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /\.page \{ overflow-y: auto;/);
  assert.match(css, /\.page-flow \.graph-card \{ flex: 0 0 360px; min-height: 360px;/);
  const layout = h.run('layout([{id:"a",owner:"a",deps:[]},{id:"b",owner:"b",deps:[]}], 300)');
  assert.ok([...layout.pos.values()].every((p) => p.x >= 0));
});
