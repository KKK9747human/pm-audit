import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import { EventEmitter, getEventListeners } from 'node:events';
import { spawn as spawnNode } from 'node:child_process';
import { probeRemote, classifyProbe } from '../src/watch.mjs';

const filename = fileURLToPath(new URL('../src/gh.mjs', import.meta.url));
const source = readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
const endpoint = 'repos/fixture/never-contact/probe';
const unitOptions = { timeout: 2000 };
const turn = () => new Promise((resolve) => setImmediate(resolve));

function loadGh(spawn, timers) {
  const imports = {
    'node:child_process': {
      spawn,
      execFileSync: () => assert.fail('synchronous gh/network calls are forbidden'),
    },
  };
  const expanded = source.replace(/\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g,
    (_, bindings, specifier) => {
      assert.ok(Object.hasOwn(imports, specifier), `unmocked dependency: ${specifier}`);
      return `const ${bindings.trim().replace(/\b(\w+)\s+as\s+(\w+)\b/g, '$1: $2')} = __imports[${JSON.stringify(specifier)}];`;
    }).replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/g, '');
  const context = createContext({
    __imports: imports, Buffer, AbortController, AbortSignal, DOMException,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  }, { codeGeneration: { strings: false, wasm: false } });
  // Expose the private runner only inside this VM to isolate wrapper failures.
  return new Script(`${expanded}\n;({ ghRun, ghJson });`, { filename })
    .runInContext(context, { timeout: 1000 });
}

function clock() {
  let now = 0;
  const pending = new Map();
  return {
    setTimeout(callback, ms = 0, ...args) {
      const handle = { ref() { return this; }, unref() { return this; } };
      pending.set(handle, { at: now + Math.max(0, Number(ms)), callback, args });
      return handle;
    },
    clearTimeout(handle) { pending.delete(handle); },
    clear() { pending.clear(); },
    get size() { return pending.size; },
    async advance(ms) {
      const target = now + ms;
      for (let steps = 0; ; steps++) {
        assert.ok(steps < 100, 'bounded scheduler must not loop indefinitely');
        const next = [...pending.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [handle, timer] = next;
        now = timer.at;
        pending.delete(handle);
        timer.callback(...timer.args);
        await turn();
      }
      now = target;
      await turn();
    },
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.inputs = [];
  child.stdin = { end: (input) => child.inputs.push(input) };
  child.killCalls = [];
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.killCalls.push(signal);
    child.killed = true;
    // Deliberately do not emit close: kill() is not proof of cleanup.
    return true;
  };
  child.close = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('close', code, signal);
  };
  return child;
}

function fixture(t, { spawnError } = {}) {
  const timers = clock();
  const children = [];
  const calls = [];
  t.after(() => timers.clear());
  const api = loadGh((command, args, options) => {
    assert.equal(command, 'gh');
    calls.push({ command, args: Array.from(args), options });
    if (spawnError) throw spawnError;
    const child = fakeChild();
    children.push(child);
    return child;
  }, timers);
  return { ...api, timers, children, calls };
}

// Attach both handlers so failed assertions cannot leave unhandled rejections.
function observe(promise) {
  const state = { status: 'pending' };
  const done = Promise.resolve(promise).then(
    (value) => Object.assign(state, { status: 'fulfilled', value }),
    (reason) => Object.assign(state, { status: 'rejected', reason }),
  );
  return { state, done };
}

function rejectedWith(result, reason) {
  assert.equal(result.state.status, 'rejected', 'operation must reject without waiting for another timer');
  assert.equal(result.state.reason, reason, 'rejection must be exactly signal.reason, not a wrapper');
}

function noAbortListeners(signal) {
  assert.equal(getEventListeners(signal, 'abort').length, 0, 'abort listener must be removed');
}

for (const [label, reason] of [
  ['Error', new Error('probe hard deadline')],
  ['opaque object', { kind: 'probe-cancelled' }],
  ['null', null],
]) {
  test(`pre-aborted ghJson does not spawn and preserves ${label} reason`, unitOptions, async (t) => {
    const f = fixture(t);
    const controller = new AbortController();
    controller.abort(reason);
    const result = observe(f.ghJson(endpoint, { signal: controller.signal, retries: 4 }));
    await turn();
    assert.equal(f.calls.length, 0, 'pre-aborted operations must never spawn');
    rejectedWith(result, controller.signal.reason);
    assert.equal(f.timers.size, 0);
    noAbortListeners(controller.signal);
  });
}

for (const closeCode of [null, 0]) {
  test(`mid-flight abort kills once and waits for close (${closeCode}) without retry`, unitOptions, async (t) => {
    const f = fixture(t);
    const controller = new AbortController();
    const reason = new Error('probe deadline expired');
    const result = observe(f.ghJson(endpoint, {
      signal: controller.signal, timeout: 50, retries: 4,
    }));
    const child = f.children[0];
    child.stdout.emit('data', Buffer.from('{"partial":'));
    controller.abort(reason);
    await turn();
    assert.equal(child.killCalls.length, 1, 'abort must kill the running child');
    assert.equal(result.state.status, 'pending', 'kill alone must not settle the operation');
    child.emit('exit', closeCode, closeCode === null ? 'SIGTERM' : null);
    await turn();
    assert.equal(result.state.status, 'pending', 'exit is not close; stdio may still be open');
    controller.abort(new Error('duplicate abort'));
    await f.timers.advance(50);
    assert.equal(child.killCalls.length, 1, 'a competing timeout must not kill twice');
    assert.equal(result.state.status, 'pending');
    child.close(closeCode, closeCode === null ? 'SIGTERM' : null);
    await turn();
    rejectedWith(result, reason);
    assert.equal(f.calls.length, 1);
    assert.equal(f.timers.size, 0, 'cancellation must not schedule a retry');
    noAbortListeners(controller.signal);
    await f.timers.advance(20000);
    assert.equal(f.calls.length, 1);
    assert.equal(child.killCalls.length, 1);
  });
}

for (const entry of ['ghRun', 'ghJson']) {
  for (const closeCode of [null, 0]) {
    test(`${entry} timeout waits for close (${closeCode}) and preserves GH_TIMEOUT without partial stdout`, unitOptions, async (t) => {
      const f = fixture(t);
      const controller = new AbortController();
      const options = { timeout: 50, retries: 1, signal: controller.signal };
      const result = observe(entry === 'ghRun'
        ? f.ghRun(['api', endpoint], options) : f.ghJson(endpoint, options));
      const child = f.children[0];
      child.stdout.emit('data', Buffer.from('{"private":"partial-stdout-secret"'));
      await f.timers.advance(49);
      assert.equal(child.killCalls.length, 0);
      await f.timers.advance(1);
      assert.equal(child.killCalls.length, 1);
      assert.equal(result.state.status, 'pending', 'timeout must wait for close after killing');
      child.emit('exit', closeCode, closeCode === null ? 'SIGTERM' : null);
      await turn();
      assert.equal(result.state.status, 'pending');
      child.close(closeCode, closeCode === null ? 'SIGTERM' : null);
      await turn();
      assert.equal(result.state.status, 'rejected', 'timeout must reject even if the child exits zero');
      assert.equal(result.state.reason.code, 'GH_TIMEOUT', 'structured timeout must survive ghJson wrapping');
      assert.doesNotMatch(String(result.state.reason.message), /partial-stdout-secret|\{"private"/);
      assert.equal(f.timers.size, 0);
      noAbortListeners(controller.signal);
      controller.abort(new Error('too late'));
      await f.timers.advance(20000);
      assert.equal(child.killCalls.length, 1);
      assert.equal(f.calls.length, 1);
    });
  }
}

test('successful ghJson preserves request/body behavior and cleans up before a later abort', unitOptions, async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const body = { title: 'fixture' };
  const result = observe(f.ghJson(endpoint, {
    method: 'POST', body, signal: controller.signal, timeout: 50,
  }));
  const child = f.children[0];
  assert.deepEqual(f.calls[0].args, [
    'api', '-X', 'POST', endpoint, '-H', 'Accept: application/vnd.github+json', '--input', '-',
  ]);
  assert.deepEqual(Array.from(f.calls[0].options.stdio), ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(child.inputs, [JSON.stringify(body)]);
  child.stdout.emit('data', Buffer.from('  {"ok":'));
  child.stdout.emit('data', Buffer.from('true}  \n'));
  child.close(0);
  await turn();
  assert.equal(result.state.status, 'fulfilled');
  assert.equal(result.state.value.ok, true);
  assert.equal(f.timers.size, 0);
  noAbortListeners(controller.signal);
  controller.abort(new Error('after success'));
  await f.timers.advance(10000);
  assert.equal(child.killCalls.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(result.state.status, 'fulfilled');
});

test('no-signal empty successful response still returns null', unitOptions, async (t) => {
  const f = fixture(t);
  const result = observe(f.ghJson(endpoint));
  const child = f.children[0];
  assert.deepEqual(child.inputs, ['']);
  assert.deepEqual(f.calls[0].args, [
    'api', '-X', 'GET', endpoint, '-H', 'Accept: application/vnd.github+json',
  ]);
  child.stdout.emit('data', Buffer.from(' \n'));
  child.close(0);
  await turn();
  assert.equal(result.state.status, 'fulfilled');
  assert.equal(result.state.value, null);
  assert.equal(f.timers.size, 0);
});

test('abort during retry delay rejects immediately, clears delay and prevents another spawn', unitOptions, async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const reason = { kind: 'deadline-during-backoff' };
  const result = observe(f.ghJson(endpoint, { signal: controller.signal, retries: 4 }));
  const child = f.children[0];
  child.stderr.emit('data', Buffer.from('temporary transport failure'));
  child.close(1);
  await turn();
  assert.equal(result.state.status, 'pending');
  assert.equal(f.timers.size, 1, 'only the retry delay should remain');
  await f.timers.advance(1000);
  assert.equal(f.calls.length, 1);
  controller.abort(reason);
  await turn();
  rejectedWith(result, reason);
  assert.equal(f.timers.size, 0, 'abort must cancel, not merely ignore, the retry timer');
  noAbortListeners(controller.signal);
  await f.timers.advance(200000);
  assert.equal(f.calls.length, 1, 'advancing beyond backoff must not start another child');
  assert.equal(child.killCalls.length, 0, 'the already-closed child must not be killed');
});

for (const entry of ['ghRun', 'ghJson']) {
  test(`${entry} spawn error clears timer/listener without requiring close`, unitOptions, async (t) => {
    const f = fixture(t);
    const controller = new AbortController();
    const error = Object.assign(new Error('synthetic spawn ENOENT'), { code: 'ENOENT' });
    const options = { signal: controller.signal, timeout: 50, retries: 1 };
    const result = observe(entry === 'ghRun'
      ? f.ghRun(['api', endpoint], options) : f.ghJson(endpoint, options));
    const child = f.children[0];
    child.emit('error', error);
    await turn();
    assert.equal(result.state.status, 'rejected');
    if (entry === 'ghRun') assert.equal(result.state.reason, error);
    else assert.match(result.state.reason.message, /synthetic spawn ENOENT/);
    assert.equal(f.timers.size, 0, 'spawn error must clear the deadline even before close');
    noAbortListeners(controller.signal);
    controller.abort(new Error('after spawn failure'));
    await f.timers.advance(10000);
    assert.equal(child.killCalls.length, 0);
    assert.equal(f.calls.length, 1);
    child.close(-2);
    await turn();
    assert.equal(result.state.status, 'rejected');
    assert.equal(f.timers.size, 0);
  });
}

test('synchronous spawn failure leaves no deadline or abort listener', unitOptions, async (t) => {
  const spawnError = new Error('synthetic synchronous spawn failure');
  const f = fixture(t, { spawnError });
  const controller = new AbortController();
  const result = observe(f.ghJson(endpoint, { signal: controller.signal, retries: 1 }));
  await turn();
  assert.equal(result.state.status, 'rejected');
  assert.match(result.state.reason.message, /synthetic synchronous spawn failure/);
  assert.equal(f.timers.size, 0);
  noAbortListeners(controller.signal);
  controller.abort(new Error('after failure'));
  await f.timers.advance(200000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.children.length, 0);
});

test('ordinary no-signal failures and malformed JSON retain retry/backoff then succeed', unitOptions, async (t) => {
  const f = fixture(t);
  const result = observe(f.ghJson(endpoint));
  f.children[0].stderr.emit('data', Buffer.from('temporary failure'));
  f.children[0].close(1);
  await turn();
  assert.equal(f.timers.size, 1);
  await f.timers.advance(1999);
  assert.equal(f.calls.length, 1);
  await f.timers.advance(1);
  assert.equal(f.calls.length, 2);
  f.children[1].stdout.emit('data', Buffer.from('{malformed'));
  f.children[1].close(0);
  await turn();
  assert.equal(f.timers.size, 1);
  await f.timers.advance(3999);
  assert.equal(f.calls.length, 2);
  await f.timers.advance(1);
  assert.equal(f.calls.length, 3);
  f.children[2].stdout.emit('data', Buffer.from('{"attempt":3}'));
  f.children[2].close(0);
  await turn();
  assert.equal(result.state.status, 'fulfilled');
  assert.equal(result.state.value.attempt, 3);
  assert.equal(f.timers.size, 0);
  assert.ok(f.children.every((child) => child.killCalls.length === 0));
});

for (const data of [undefined, null, { repository: { nameWithOwner: 'fixture/never-contact' } }]) {
  test(`GraphQL nonzero exit retains error envelope with ${data === undefined ? 'absent' : data === null ? 'null' : 'partial'} data without retry`, unitOptions, async (t) => {
    const f = fixture(t);
    const controller = new AbortController();
    const envelope = { ...(data === undefined ? {} : { data }), errors: [{ message: 'fixture incomplete result' }] };
    const result = observe(f.ghJson('graphql', {
      method: 'POST', body: { query: 'query { viewer { login } }' }, signal: controller.signal,
    }));
    f.children[0].stdout.emit('data', Buffer.from(JSON.stringify(envelope)));
    f.children[0].stderr.emit('data', Buffer.from('gh: fixture incomplete result'));
    f.children[0].close(1);
    await turn();
    assert.equal(result.state.status, 'fulfilled');
    assert.deepEqual(JSON.parse(JSON.stringify(result.state.value)), envelope);
    assert.equal(f.calls.length, 1);
    assert.equal(f.timers.size, 0);
    noAbortListeners(controller.signal);
  });
}

for (const [path, stdout] of [
  [endpoint, '{"errors":[{"message":"REST failure"}]}'],
  ['graphql', ''], ['graphql', '{"errors":'],
  ['graphql', '{"errors":[]}'], ['graphql', '{"data":{"ok":true}}'],
]) {
  test(`nonzero ${path} with ${JSON.stringify(stdout)} remains a transport failure`, unitOptions, async (t) => {
    const f = fixture(t);
    const result = observe(f.ghJson(path, { retries: 2 }));
    f.children[0].stdout.emit('data', Buffer.from(stdout));
    f.children[0].stderr.emit('data', Buffer.from('fixture connection interrupted'));
    f.children[0].close(1);
    await turn();
    assert.equal(result.state.status, 'pending');
    await f.timers.advance(2000);
    assert.equal(f.calls.length, 2);
    f.children[1].stderr.emit('data', Buffer.from('fixture connection interrupted'));
    f.children[1].close(1);
    await turn();
    assert.equal(result.state.status, 'rejected');
    assert.match(result.state.reason.message, /fixture connection interrupted/);
    assert.equal(f.timers.size, 0);
  });
}

for (const stop of ['abort', 'timeout']) {
  test(`GraphQL error stdout cannot override ${stop}`, unitOptions, async (t) => {
    const f = fixture(t);
    const controller = new AbortController();
    const reason = new Error('fixture cancelled');
    const result = observe(f.ghJson('graphql', { signal: controller.signal, timeout: 50, retries: 1 }));
    f.children[0].stdout.emit('data', Buffer.from('{"errors":[{"message":"partial result"}]}'));
    if (stop === 'abort') controller.abort(reason);
    else await f.timers.advance(50);
    f.children[0].close(1);
    await turn();
    assert.equal(result.state.status, 'rejected');
    if (stop === 'abort') rejectedWith(result, reason);
    else assert.equal(result.state.reason.code, 'GH_TIMEOUT');
    assert.equal(f.calls.length, 1);
    assert.equal(f.timers.size, 0);
  });
}

for (const failedKind of ['pulls', 'issues']) {
  test(`probe returns unknown for actual ghJson nonzero ${failedKind} partial response`, unitOptions, async (t) => {
    const f = fixture(t);
    const sha = 'b'.repeat(40);
    const project = { id: 'fixture', repo: 'fixture/never-contact', defaultBranch: 'main' };
    let graphCalls = 0;
    const request = async (url, options) => {
      if (url === `repos/${project.repo}`) return { pushed_at: '2026-11-20T10:00:00Z', default_branch: 'main' };
      if (url === `repos/${project.repo}/branches?per_page=100&page=1`) return [{ name: 'main', commit: { sha } }];
      assert.equal(url, 'graphql');
      graphCalls++;
      const failed = options.body.query.includes('pullRequests(') === (failedKind === 'pulls');
      const envelope = { data: { repository: {
        nameWithOwner: project.repo,
        entries: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      } }, ...(failed ? { errors: [{ message: 'fixture partial response' }] } : {}) };
      const promise = f.ghJson(url, options);
      const child = f.children.at(-1);
      child.stdout.emit('data', Buffer.from(JSON.stringify(envelope)));
      if (failed) child.stderr.emit('data', Buffer.from('gh: fixture partial response'));
      child.close(failed ? 1 : 0);
      return promise;
    };
    const next = await probeRemote(project, { request, now: () => 0, sleep: async () => {} });
    assert.equal(next.snapshotComplete, false);
    assert.equal(classifyProbe({ prevProbe: next, nextProbe: next, projectId: project.id }).unknown, true);
    assert.equal(graphCalls, 2);
    assert.equal(f.calls.length, 2);
    assert.equal(f.timers.size, 0);
  });
}

function bounded(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`test watchdog: ${label}`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

test('real local Node child is closed and terminated before cancellation rejects', { timeout: 8000 }, async (t) => {
  const controller = new AbortController();
  const reason = new Error('handshake-triggered probe deadline');
  const timers = new Set();
  let child;
  let closePromise;
  let closed = false;
  let nativeKill;
  let killCalls = 0;
  let spawnCalls = 0;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Observe startup rejection even if an earlier assertion fails.
  ready.catch(() => {});
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (child && !closed) {
      nativeKill('SIGKILL');
      await bounded(closePromise, 4000, 'local child cleanup');
    }
  });
  const api = loadGh((command, args, options) => {
    assert.equal(command, 'gh');
    assert.equal(args[0], 'api');
    spawnCalls++;
    // The child watchdog also bounds broken cancellation implementations.
    child = spawnNode(process.execPath, ['-e', `
      setInterval(() => {}, 1000);
      setTimeout(() => process.exit(91), 3000).unref();
      process.stdout.write('READY\\n');
    `], { stdio: Array.from(options.stdio) });
    nativeKill = child.kill.bind(child);
    child.kill = (...killArgs) => { killCalls++; return nativeKill(...killArgs); };
    closePromise = new Promise((resolve) => child.once('close', (code, signal) => {
      closed = true;
      readyReject(new Error('local child closed before handshake'));
      resolve({ code, signal });
    }));
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('READY\n')) readyResolve();
    });
    child.once('error', readyReject);
    return child;
  }, {
    setTimeout(callback, ms, ...args) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback(...args);
      }, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  });
  let closedAtSettlement;
  let terminatedAtSettlement;
  const result = observe(api.ghJson(endpoint, {
    signal: controller.signal, retries: 1, timeout: 60000,
  }).then((value) => {
    closedAtSettlement = closed;
    terminatedAtSettlement = child.exitCode !== null || child.signalCode !== null;
    return value;
  }, (error) => {
    closedAtSettlement = closed;
    terminatedAtSettlement = child.exitCode !== null || child.signalCode !== null;
    throw error;
  }));
  await bounded(ready, 2500, 'local child stdout handshake');
  controller.abort(reason);
  await turn();
  assert.equal(killCalls, 1, 'abort must kill the real child, not wait for its watchdog');
  await bounded(result.done, 2500, 'cancellation settlement after close');
  rejectedWith(result, reason);
  assert.equal(closedAtSettlement, true, 'promise rejection must follow the actual close event');
  assert.equal(terminatedAtSettlement, true, 'exitCode/signalCode must prove termination at rejection');
  assert.equal(closed, true);
  assert.throws(() => process.kill(child.pid, 0), (error) => error.code === 'ESRCH',
    'the child PID must no longer be running');
  assert.equal(timers.size, 0);
  noAbortListeners(controller.signal);
  assert.equal(spawnCalls, 1);
});
