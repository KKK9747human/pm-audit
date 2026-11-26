import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { server } from './ui-server.mjs';

const artifacts = mkdtempSync(join(tmpdir(), 'pm-browser-acceptance-'));
const edge = process.env.PM_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${join(artifacts, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let ws;
let id = 0;
let sessionId;
const pending = new Map();
const errors = [];
let assertions = 0;
function check(value, message) { assert.ok(value, message); assertions++; console.log(`PASS ${message}`); }
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 30000);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Browser exited ${code}`)));
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) {
      const task = pending.get(msg.id);
      if (!task) return;
      pending.delete(msg.id);
      clearTimeout(task.timer);
      if (msg.error) task.reject(new Error(JSON.stringify(msg.error))); else task.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails);
  });
  const send = (method, params = {}, attached = true) => new Promise((resolve, reject) => {
    const seq = ++id;
    const timer = setTimeout(() => { pending.delete(seq); reject(new Error(`CDP timeout ${method}`)); }, 20000);
    pending.set(seq, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: seq, method, params, ...(attached && sessionId ? { sessionId } : {}) }));
  });
  const target = await send('Target.createTarget', { url: 'about:blank' }, false);
  ({ sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, false));
  await send('Runtime.enable');
  await send('Page.enable');
  const run = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = (expression) => run(`new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const test = () => { if (${expression}) return resolve(true); if (Date.now() > deadline) return reject(new Error('UI wait timed out: ' + ${JSON.stringify(expression)})); setTimeout(test, 30); }; test(); })`);
  const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const configure = async (config) => {
    const response = await fetch(`${base}/__fixture`, { method: 'POST', body: JSON.stringify(config) });
    assert.equal(response.status, 200);
  };
  const screenshot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const path = join(artifacts, `${name}.png`);
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
    console.log(`SCREENSHOT ${path}`);
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/?cb=${Date.now()}` });
  await wait(`document.querySelector('#pname')?.textContent === '测试数据 甲' && document.querySelector('#graph')?.children.length > 0`);
  check(await run(`innerWidth === 1440 && innerHeight === 900`), 'real browser viewport 1440x900');
  await wait(`document.querySelector('#next-actions')?.textContent.includes('A2')`);
  check(await run(`document.querySelector('#btn-publish').disabled`), 'read-only publication disabled');
  check(await run(`!document.querySelector('#next-actions').textContent.includes('A3「')`), 'action card names actionable root rather than blocked descendant');
  await screenshot('desktop-flow');
  const desktopNode = await run(`(() => { const rect=document.querySelector('#graph .node-box').getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...desktopNode });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...desktopNode, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...desktopNode, button: 'left', clickCount: 1 });
  await wait(`document.querySelector('#drawer').hidden === false`);
  check(await run(`document.querySelector('#drawer').textContent.includes('A1')`), 'desktop graph hover preserves node click and opens the correct drawer');
  await click('#drawer .close');
  for (let page = 0; page < 5; page++) {
    await click(`#page-nav [data-page="${page}"]`);
    check(await run(`document.querySelector('#page-nav [data-page="${page}"]').classList.contains('on')`), `navigation page ${page + 1}`);
  }
  const openProject = async (index, name) => {
    await click(`#projects .proj:nth-child(${index})`);
    await wait(`document.querySelector('#pname').textContent === ${JSON.stringify(name)} && !document.querySelector('#btn-sync').disabled`);
  };
  const reloadProject = async () => { await openProject(2, '测试数据 乙'); await openProject(1, '测试数据 甲'); };
  await configure({ legacy: true });
  await reloadProject();
  await wait(`document.querySelector('#trail-verify').textContent.includes('旧版')`);
  check(await run(`!document.querySelector('#trail-verify').textContent.includes('不匹配')`), 'legacy bundle is not mislabeled as fingerprint mismatch');
  await configure({ mismatch: true });
  await reloadProject();
  await wait(`/不匹配|不一致/.test(document.querySelector('#trail-verify').textContent)`);
  await configure({});
  await reloadProject();
  await wait(`document.querySelector('#trail-verify').textContent.includes('自洽')`);
  check(await run(`document.querySelector('#trail').textContent.includes('CI 未知')`), 'missing CI evidence remains unknown');
  await click('#page-nav [data-page="2"]');
  await screenshot('desktop-trail');
  await openProject(3, '测试数据 空项目');
  await wait(`document.querySelector('#welcome').hidden === false`);
  await click('#who');
  check(await run(`document.querySelector('#modal').textContent.includes('成员')`), 'empty-project identity entry remains accessible');
  check(await run(`!document.querySelector('#modal').textContent.includes('undefined')`), 'empty identity dialog never offers undefined member');
  await screenshot('empty-identity');
  await click('#modal-mask');
  await openProject(4, '测试数据 未绑定');
  await click('#who');
  check(await run(`document.querySelector('#modal select')?.value === ''`), 'unmatched identity requires explicit member selection');
  await screenshot('unbound-identity');
  await click('#modal-mask');
  const fixture = await (await fetch(`${base}/__fixture`)).json();
  check(!fixture.hits.some((hit) => /\/(identity|publish|pr-note|interpret)$/.test(hit.path) && hit.method === 'POST'), 'identity inspection and read-only navigation make no write requests');
  const waitRequests = (predicate = 'hits.length > 0 && hits.every(hit => hit.done)') => run(`new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const test = async () => { const {hits} = await (await fetch('/__fixture')).json(); if (${predicate}) return resolve(hits); if (Date.now() > deadline) return reject(new Error('Fixture request wait timed out')); setTimeout(test, 30); }; test(); })`);
  await click('#who');
  check(await run(`document.querySelector('#modal .primary').disabled`), 'identity save stays disabled without an explicit selection');
  await run(`const member=document.querySelector('#modal select'); member.value='m2'; member.dispatchEvent(new Event('change', {bubbles:true}));`);
  await click('#modal .primary');
  await wait(`document.querySelector('#modal-mask').hidden && document.querySelector('#main').getAttribute('aria-busy') !== 'true'`);
  await waitRequests();
  const identityRequest = (await (await fetch(`${base}/__fixture`)).json()).hits.find(hit=>hit.path.endsWith('/identity') && hit.method === 'POST');
  check(identityRequest?.path === '/api/projects/fixture-unbound/identity' && identityRequest.body?.memberId === 'm2', 'explicit identity save targets the selected member in the selected project');
  check(await run(`document.querySelector('#btn-publish').disabled`), 'identity save does not enable publication for a read-only role');
  await configure({ delays: { '/api/projects/fixture-a': 700 } });
  await click('#projects .proj:nth-child(1)');
  await waitRequests(`hits.some(hit => hit.path === '/api/projects/fixture-a')`);
  await openProject(2, '测试数据 乙');
  await waitRequests();
  check(await run(`document.querySelector('#pname').textContent === '测试数据 乙' && document.querySelector('#repo').textContent.includes('fixture-b')`), 'late A bundle cannot overwrite B');
  await configure({ delays: { '/api/projects/fixture-a': 700 }, errors: { '/api/projects/fixture-a': 500 } });
  await click('#projects .proj:nth-child(1)');
  await waitRequests(`hits.some(hit => hit.path === '/api/projects/fixture-a')`);
  await openProject(2, '测试数据 乙');
  await waitRequests();
  check(await run(`document.querySelector('#pname').textContent === '测试数据 乙' && document.querySelector('#welcome').hidden`), 'late A failure cannot replace B with welcome/error screen');
  await configure({ delays: { '/api/projects/fixture-a': 700 }, revisions: { 'fixture-a': 'OLD-FIXTURE' } });
  await click('#projects .proj:nth-child(1)');
  await waitRequests(`hits.some(hit => hit.path === '/api/projects/fixture-a')`);
  await openProject(2, '测试数据 乙');
  await configure({ preserveHits: true, revisions: { 'fixture-a': 'NEW-FIXTURE' } });
  await openProject(1, '测试数据 甲');
  await waitRequests();
  check(await run(`document.querySelector('#graph').textContent.includes('NEW') && !document.querySelector('#graph').textContent.includes('OLD')`), 'A-B-A navigation rejects older A generation');
  await configure({ delays: { '/api/projects/fixture-b/alerts': 700, '/api/projects/fixture-b/trail': 700 }, revisions: { 'fixture-b': 'STALE-B' } });
  await openProject(2, '测试数据 乙');
  await waitRequests(`hits.some(hit => hit.path.endsWith('/trail'))`);
  await openProject(1, '测试数据 甲');
  await waitRequests();
  check(await run(`!document.querySelector('#trail').textContent.includes('STALE-B') && !document.querySelector('#next-actions').textContent.includes('STALE-B')`), 'late evidence and action cards cannot cross project boundaries');
  await configure({});
  await click('#page-nav [data-page="3"]');
  await click('#btn-agent');
  await wait(`!document.querySelector('#modal-mask').hidden && document.querySelector('#modal').textContent.includes('Agent')`);
  await screenshot('agent-handoff');
  await run(`Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async text => {window.fixtureCopy=text;}}}); [...document.querySelectorAll('#modal button')].find(el=>el.textContent.includes('复制接入提示词')).click()`);
  await wait(`typeof window.fixtureCopy === 'string'`);
  check(await run(`window.fixtureCopy.includes('fixture/fixture-a') && /sha256:[0-9a-f]{64}/.test(window.fixtureCopy)`), 'copied onboarding contains target repository and full fingerprint');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: artifacts }, false);
  await run(`window.fixtureBlobs=[]; const originalCreate=URL.createObjectURL; URL.createObjectURL=blob=>{window.fixtureBlobs.push(blob); return originalCreate(blob);}; [...document.querySelectorAll('#modal button')].find(el=>el.textContent.includes('下载全部节点')).click()`);
  await wait(`window.fixtureBlobs.length > 0`);
  const handoff = await run(`Promise.all(window.fixtureBlobs.map(blob=>blob.text())).then(parts=>parts.join(String.fromCharCode(10)))`);
  check(handoff.includes('fixture/fixture-a') && handoff.includes('默认分支：main'), 'downloaded standalone tasks retain repository and default branch');
  check(/sha256:[0-9a-f]{64}/.test(handoff) && handoff.includes('停止条件') && handoff.includes('完成后报告格式'), 'downloaded task retains fingerprint, stop conditions and report contract');
  check(handoff.includes('不代表认领') && !handoff.includes('fixture/fixture-b'), 'downloaded handoff is project-specific and never implies ownership');
  await click('#modal-mask');
  await configure({ delays: { '/api/projects/fixture-b/agent': 700 } });
  await openProject(2, '测试数据 乙');
  await click('#btn-agent');
  await waitRequests(`hits.some(hit=>hit.path === '/api/projects/fixture-b/agent')`);
  await openProject(1, '测试数据 甲');
  await waitRequests();
  check(await run(`document.querySelector('#modal-mask').hidden && document.querySelector('#pname').textContent === '测试数据 甲'`), 'late B agent response cannot reopen a modal over A');
  await configure({});
  await click('#page-nav [data-page="0"]');
  await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 700, deviceScaleFactor: 1, mobile: false });
  const waitGraphLayout = async () => {
    try {
      await wait(`(() => { const box=document.querySelector('#graph-scroll'); const width=Number(document.querySelector('#graph').getAttribute('width')); return width >= Math.max(300, box.clientWidth) && width <= Math.max(300, box.offsetWidth); })()`);
    } catch (err) {
      console.log('GRAPH_LAYOUT', await run(`(() => { const box=document.querySelector('#graph-scroll'); const svg=document.querySelector('#graph'); return {viewport:innerWidth,boxWidth:box.clientWidth,svgWidth:svg.getAttribute('width'),boxHeight:box.clientHeight,svgHeight:svg.getAttribute('height'),scrollLeft:box.scrollLeft,scrollTop:box.scrollTop,nodes:[...svg.querySelectorAll('.node-box')].map(n=>n.getAttribute('transform'))}; })()`));
      await screenshot('graph-layout-failure');
      throw err;
    }
  };
  await wait(`innerWidth === 800`);
  await waitGraphLayout();
  const narrow = await run(`(() => { const graph = document.querySelector('.graph-card'); const rect = graph.getBoundingClientRect(); document.querySelector('.page-flow').scrollTop = graph.offsetTop; return { height: rect.height, bodyWidth: document.body.scrollWidth, width: innerWidth, scroll: document.querySelector('.page-flow').scrollHeight }; })()`);
  check(narrow.height >= 250, `narrow viewport retains graph height (${narrow.height})`);
  check(narrow.bodyWidth <= 800, 'narrow viewport does not overflow horizontally');
  await screenshot('narrow-flow');
  for (const width of [800, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
    await waitGraphLayout();
    check(await run(`(() => { const box=document.querySelector('#graph-scroll').getBoundingClientRect(); const node=document.querySelector('#graph .node-box').getBoundingClientRect(); return node.left >= box.left && node.right <= box.right; })()`), `graph nodes fit the resized ${width}px viewport`);
    for (let page = 0; page < 5; page++) {
      const point = await run(`(() => { const rect=document.querySelector('#page-nav [data-page="${page}"]').getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`);
      assert.ok(point.x >= 0 && point.x < width && point.y >= 0 && point.y < 700, `page control visible at ${width}px`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      await wait(`document.querySelector('#page-nav [data-page="${page}"]').classList.contains('on')`);
    }
    check(true, `all five pages reachable with real pointer at ${width}px`);
    await click('#page-nav [data-page="0"]');
    check(await run(`document.body.scrollWidth <= innerWidth`), `no horizontal page overflow at ${width}px`);
    await screenshot(`narrow-${width}`);
  }
  await send('Page.navigate', { url: `${base}/?cb=phone-${Date.now()}` });
  await wait(`document.querySelector('#pname')?.textContent === '测试数据 甲' && document.querySelector('#graph .node-box') && document.querySelector('#next-actions').textContent.includes('A2') && !document.querySelector('#btn-sync').disabled`);
  await waitRequests();
  await waitGraphLayout();
  await run(`new Promise(resolve => { let timer; const done=()=>{observer.disconnect(); resolve();}; const settle=()=>{clearTimeout(timer); timer=setTimeout(done, 200);}; const observer=new MutationObserver(settle); observer.observe(document.querySelector('#graph'), {attributes:true, childList:true, subtree:true}); settle(); })`);
  await run(`document.querySelector('.page-flow').scrollTop = document.querySelector('.graph-card').offsetTop`);
  await screenshot('phone-fresh-flow');
  const nodePoint = await run(`(() => { const node=document.querySelector('#graph .node-box').getBoundingClientRect(); const box=document.querySelector('#graph-scroll').getBoundingClientRect(); const x=node.x+node.width/2, y=node.y+node.height/2; return {x,y,hit:document.elementFromPoint(x,y)?.closest('.node-box')?.dataset.id,visible:node.left>=box.left && node.right<=box.right && node.top>=box.top && node.bottom<=box.bottom}; })()`);
  check(nodePoint.visible && nodePoint.x < 390 && nodePoint.y < 700 && nodePoint.hit === 'A1', 'fresh phone load shows a complete, clickable graph node without horizontal scrolling');
  await run(`window.fixturePointerEvents=[]; for (const type of ['pointerdown','pointerup','mousedown','mouseup','click']) document.addEventListener(type, event=>window.fixturePointerEvents.push({type,target:event.target.tagName,node:event.target.closest('.node-box')?.dataset.id}), true)`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nodePoint.x, y: nodePoint.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nodePoint.x, y: nodePoint.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nodePoint.x, y: nodePoint.y, button: 'left', clickCount: 1 });
  try {
    await wait(`document.querySelector('#drawer').hidden === false`);
  } catch (err) {
    console.log('NODE_CLICK', { nodePoint, events: await run('window.fixturePointerEvents'), errors });
    await screenshot('node-click-failure');
    throw err;
  }
  check(await run(`document.querySelector('#drawer').textContent.includes('A1')`), 'phone graph node opens its own detail drawer with a real pointer');
  await click('#drawer .close');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: nodePoint.x, y: nodePoint.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(`document.querySelector('#drawer').hidden === false`);
  check(await run(`document.querySelector('#drawer').textContent.includes('A1')`), 'phone touch tap opens the correct graph node without prior hover');
  check(errors.length === 0, `no unhandled browser exceptions (${errors.length})`);
  console.log(`RESULT ${assertions} browser assertions passed; artifacts ${artifacts}`);
  await send('Browser.close', {}, false).catch(() => {});
} finally {
  ws?.close();
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill(), 2500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  try {
    rmSync(join(artifacts, 'profile'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    console.warn(`Browser profile cleanup: ${err.message}`);
  }
}
