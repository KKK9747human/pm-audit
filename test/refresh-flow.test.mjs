import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';

// Read source, never import either executable (or its remote/model dependencies).
const repo = fileURLToPath(new URL('../', import.meta.url));
const source = (file) => fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n');
const stateSource = source('src/refresh-state.mjs');
const lockSource = source('src/project-lock.mjs');
const serverSource = source('server.mjs');
const cliSource = source('bin/pmctl.mjs');
const NOW = '2026-11-20T10:00:00.000Z';
const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const PREVIOUS = `sha256:${'0'.repeat(64)}`;
const COMMIT = 'c'.repeat(40);
const SIG_A = 'remote-signature-a';
const SIG_B = 'remote-signature-b';
const ID = 'isolated-refresh';
const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const watchSource = source('src/watch.mjs');
const denied = new Proxy({}, { get: () => () => assert.fail('unmocked watch dependency') });
const watchImports = Object.fromEntries([
  'node:fs', 'node:path', 'node:child_process', './llm.mjs', './bundle.mjs',
  './brand.mjs', './comment.mjs', './gh.mjs', './project-lock.mjs',
].map((name) => [name, denied]));
const watchExpanded = watchSource.replace(/\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g, (_, bindings, name) => {
  assert.ok(Object.hasOwn(watchImports, name), `unexpected watch dependency: ${name}`);
  return `const ${bindings.trim()} = __imports[${JSON.stringify(name)}];`;
}).replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/g, '');
const watchApi = new Script(`${watchExpanded}\n;({ probeRemote, signatureOf, classifyProbe, decideRefresh });`)
  .runInContext(createContext({ __imports: watchImports, AbortController, setTimeout, clearTimeout }, { codeGeneration: { strings: false, wasm: false } }), { timeout: 1000 });

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return Date.parse(NOW); }
}

function between(text, start, end) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `entry marker missing: ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `entry boundary missing: ${end}`);
  return text.slice(from + start.length, to);
}

// 取一个顶层函数的完整源码：函数体的收尾大括号在第 0 列，内层大括号都有缩进。
// 不能用「截到某个固定标记为止」的办法——服务端文件一改，那个标记后面可能多出别的函数。
function topLevelFunction(text, signature) {
  const from = text.indexOf(signature);
  assert.notEqual(from, -1, `entry marker missing: ${signature}`);
  const end = text.indexOf('\n}\n', from);
  assert.notEqual(end, -1, `function end missing: ${signature}`);
  return text.slice(from, end + 3);
}

// Preserve the entire function region, including helpers added before createServer.
const refreshBody = topLevelFunction(serverSource, 'async function handleRefresh(');
const retryBody = 'async function publishWithRetry(' + between(
  cliSource, 'async function publishWithRetry(', '\nconst { flags, pos }',
);
const watchBody = between(
  cliSource, "} else if (cmd === 'watch') {", "\n  } else if (cmd === 'issues')",
);

function probe(signature = SIG_A) {
  return {
    signature,
    pushedAt: NOW,
    defaultBranch: 'main',
    headSha: signature === SIG_A ? '1'.repeat(40) : '2'.repeat(40),
    openPrs: [],
    recentCommits: [],
    commitsComplete: true,
    snapshotComplete: true,
  };
}

function bundle(hash = A, marker = 'cached') {
  return {
    project: { id: ID, name: 'Isolated refresh', repo: 'fixture/never-contact' },
    asOf: NOW,
    hashes: { facts: hash },
    marker,
    facts: {
      stats: { nodes: 2, done: 1, active: 1, stale: 0, blocked: 0, ready: 0 },
      nodes: [],
      criticalPath: { path: [], len: 0 },
    },
  };
}

function baseline({ pending = true, failures = 0 } = {}) {
  return {
    // Legacy aliases allow the old implementation to reach behavioral assertions.
    signature: SIG_A,
    probe: probe(),
    lastHash: A,
    observedSignature: SIG_A,
    observedProbe: probe(),
    auditedSignature: SIG_A,
    auditedProbe: probe(),
    auditedHash: A,
    publishedSignature: 'previous-signature',
    publishedHash: PREVIOUS,
    tickCount: 1,
    failures,
    ...(pending ? {
      pendingPublish: {
        hash: A,
        signature: SIG_A,
        attemptId: 'seed-attempt-a',
        attempts: 2,
        updatedAt: NOW,
        lastError: 'previous network failure',
      },
    } : {}),
  };
}

// Evaluate every actual refresh-state export. Do not supply fake implementations
// for new APIs: old and new source both execute, including real state persistence.
function loadStateApi(root) {
  const descriptors = new Set();
  const withinFixture = (file) => {
    if (typeof file === 'number') {
      assert.ok(descriptors.has(file), 'only file descriptors opened inside the fixture are allowed');
      return;
    }
    const relative = path.relative(root, path.resolve(String(file)));
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      `filesystem access escaped OS fixture: ${file}`);
  };
  const localFs = {};
  for (const name of ['readFileSync', 'writeFileSync', 'mkdirSync', 'existsSync', 'rmSync', 'unlinkSync', 'statSync', 'readdirSync']) {
    localFs[name] = (file, ...args) => {
      withinFixture(file);
      return fs[name](file, ...args);
    };
  }
  localFs.openSync = (file, ...args) => {
    withinFixture(file);
    const fd = fs.openSync(file, ...args);
    descriptors.add(fd);
    return fd;
  };
  localFs.fsyncSync = (fd) => { withinFixture(fd); return fs.fsyncSync(fd); };
  localFs.closeSync = (fd) => {
    withinFixture(fd);
    fs.closeSync(fd);
    descriptors.delete(fd);
  };
  localFs.renameSync = (from, to) => {
    withinFixture(from);
    withinFixture(to);
    return fs.renameSync(from, to);
  };
  localFs.fsyncSync = (fd) => { withinFixture(fd); return fs.fsyncSync(fd); };
  let sequence = 0;
  const imports = {
    'node:fs': localFs,
    'node:path': path,
    'node:crypto': { ...crypto, randomUUID: () => `fixture-attempt-${++sequence}` },
  };
  const expand = (text) => text.replace(/\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g, (_, bindings, specifier) => {
    assert.ok(Object.hasOwn(imports, specifier), `unexpected refresh-state dependency: ${specifier}`);
    const names = bindings.trim();
    if (names.startsWith('{')) {
      return `const ${names.replace(/\b(\w+)\s+as\s+(\w+)\b/g, '$1: $2')} = __imports[${JSON.stringify(specifier)}];`;
    }
    if (names.startsWith('* as ')) return `const ${names.slice(5)} = __imports[${JSON.stringify(specifier)}];`;
    return `const ${names} = __imports[${JSON.stringify(specifier)}];`;
  }).replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/g, '');
  const exportsOf = (text) => [...text.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)].map((m) => m[1]);

  // Evaluate the real lock module against the same guarded fixture filesystem.
  let lockSequence = 0;
  const lockContext = createContext({
    __imports: {
      'node:fs': localFs,
      'node:path': path,
      'node:crypto': { ...crypto, randomUUID: () => `fixture-lock-${++lockSequence}` },
    },
    process: {
      pid: process.pid,
      kill: (pid, signal) => {
        assert.equal(signal, 0, 'VM may only probe process existence');
        assert.ok(Number.isInteger(pid) && pid > 0, 'VM may only probe positive PIDs');
        return process.kill(pid, 0);
      },
    },
    Atomics,
    SharedArrayBuffer,
  }, { codeGeneration: { strings: false, wasm: false } });
  const lockApi = new Script(`${expand(lockSource)}\n;({ ${exportsOf(lockSource).join(', ')} });`, {
    filename: path.join(repo, 'src/project-lock.mjs'),
  }).runInContext(lockContext, { timeout: 1000 });
  imports['./project-lock.mjs'] = lockApi;
  imports['./bundle.mjs'] = {
    loadBundle: (rootDir, id) => {
      const file = path.join(rootDir, 'data', id, 'bundle.pm.json');
      if (!localFs.existsSync(file)) return null;
      return JSON.parse(localFs.readFileSync(file, 'utf8'));
    },
    verifyBundle: () => ({ ok: true }),
  };

  const context = createContext({ __imports: imports, Date: FixedDate }, {
    codeGeneration: { strings: false, wasm: false },
  });
  const api = new Script(`${expand(stateSource)}\n;({ ${exportsOf(stateSource).join(', ')} });`, {
    filename: path.join(repo, 'src/refresh-state.mjs'),
  }).runInContext(context, { timeout: 1000 });
  return { api, lockApi, localFs };
}

function fixture(t, kind, options = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'pm-refresh-flow-'));
  const realExitCode = process.exitCode;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(process.exitCode, realExitCode, 'VM must not modify the real process.exitCode');
  });
  const { api, lockApi, localFs } = loadStateApi(root);
  const stateFile = path.join(root, 'cache', ID, kind === 'server' ? 'refresh-state.json' : 'watch-state.json');
  const bundleFile = path.join(root, 'data', ID, 'bundle.pm.json');
  fs.mkdirSync(path.dirname(bundleFile), { recursive: true });
  const saveBundle = (value) => {
    fs.writeFileSync(bundleFile, JSON.stringify(value), 'utf8');
    lockApi.writeAuditGeneration(root, ID, value.hashes.facts, ['bundle.pm.json']);
  };
  saveBundle(options.bundle || bundle());
  if (options.state !== null) api.writeState(root, ID, kind, options.state || baseline());
  const state = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  const localBundle = () => JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
  const project = {
    id: ID, name: 'Isolated refresh', repo: 'fixture/never-contact',
    admin: 'fixture-admin', members: {}, plan: { nodes: [] }, defaultBranch: 'main',
  };
  const events = [];
  const logs = [];
  const publications = [...(options.publications || [])];
  const audits = [...(options.audits || [])];
  const admin = options.admin !== false;
  const f = {
    root, api, lockApi, state, events, logs, project, remoteProbe: options.probe || probe(), lastAuditBundle: null,
  };
  const count = (type) => events.filter((event) => event.type === type).length;
  const audit = async () => {
    events.push({ type: 'audit', state: state() });
    const next = audits.length ? audits.shift() : localBundle();
    if (next instanceof Error) throw next;
    f.lastAuditBundle = next;
    saveBundle(next);
    return { bundle: next, facts: next.facts, bundlePath: bundleFile };
  };
  const sync = async () => {
    events.push({ type: 'sync' });
    f.remoteProbe = options.conflictProbe || probe(SIG_B);
    return options.syncResult || { status: 'same', hash: localBundle().hashes.facts, bundle: localBundle() };
  };
  const fakeProcess = {
    execPath: 'mock-node-no-subprocess', env: {}, argv: [], exitCode: 0,
    exit: () => assert.fail('process.exit must not be called'),
  };
  const context = createContext({
    ...localFs,
    ...api,
    ...lockApi,
    root,
    join: path.join,
    Date: FixedDate,
    process: fakeProcess,
    console: Object.fromEntries(['log', 'error', 'warn'].map((method) => [method, (...args) => logs.push(args.join(' '))])),
    apiConfig: { provider: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture-model', key: 'mock-key-no-model-request', requiresKey: true },
    refreshing: new Set(),
    getProject: () => project,
    listProjects: () => [project],
    pickProject: () => project,
    roleOf: () => ({ isAdmin: admin, admin: project.admin }),
    detectIdentity: () => ({ login: admin ? 'fixture-admin' : 'fixture-reader', memberId: null }),
    isAdmin: () => admin,
    adminList: () => [project.admin],
    adminDenied: () => 'fixture read-only identity',
    identityLabel: (identity) => identity.login,
    loadBundle: (actualRoot, id) => {
      assert.equal(actualRoot, root);
      assert.equal(id, ID);
      return localBundle();
    },
    readRefreshState: (id) => api.readState(root, id, 'server'),
    writeRefreshState: (id, value) => api.writeState(root, id, 'server', value),
    syncProject: sync,
    syncFromRemote: sync,
    confirmRemotePublish: async (actualProject, hash) => {
      assert.equal(actualProject.id, ID);
      events.push({ type: 'confirm', hash, state: state() });
      const result = f.confirmation || options.confirmation || { status: 'absent' };
      if (result instanceof Error) throw result;
      return copy(result);
    },
    auditOne: audit,
    execFileP: async (command, args, opts) => {
      assert.equal(command, fakeProcess.execPath);
      assert.equal(args[0], path.join(root, 'bin', 'pmctl.mjs'));
      assert.deepEqual(Array.from(args.slice(1)), ['audit', ID, '--fresh', '--parent-lock']);
      assert.equal(opts.cwd, root);
      const delegation = JSON.parse(opts.env.PM_AUDIT_LOCK);
      assert.equal(delegation.root, root);
      assert.equal(delegation.id, ID);
      assert.equal(delegation.pid, process.pid);
      assert.equal(delegation.token, lockApi.readLockOwner(lockApi.projectLockPath(root, ID)));
      try {
        await audit();
        return { err: null, stdout: 'fixture audit completed', stderr: '' };
      } catch (err) {
        return { err, stdout: '', stderr: err.message };
      }
    },
    watchOnce: async () => {
      events.push({ type: 'interpret' });
      return { written: [], comments: [] };
    },
    probeRemote: async (actualProject, opts) => {
      events.push({ type: 'probe', knownOwn: [...(opts?.knownOwn || [])] });
      if (f.remoteProbe instanceof Error) throw f.remoteProbe;
      if (options.realProbe) return watchApi.probeRemote(actualProject, { ...opts, request: f.request });
      return copy(f.remoteProbe);
    },
    signatureOf: options.realProbe ? watchApi.signatureOf : (value) => value?.signature || null,
    classifyProbe: options.realProbe ? watchApi.classifyProbe : ({ prevProbe, nextProbe }) => {
      if (options.classification) return options.classification;
      const changed = prevProbe?.signature !== nextProbe?.signature;
      return { changed, unchanged: !changed, ownOnly: false, unknown: false, reason: changed ? 'confirmed changed' : 'confirmed unchanged' };
    },
    decideRefresh: options.realProbe ? watchApi.decideRefresh : ({ prevSignature, nextSignature, fresh }) => {
      const changed = Boolean(fresh) || prevSignature !== nextSignature;
      return { refresh: changed, real: changed, reason: changed ? 'confirmed changed' : 'confirmed unchanged' };
    },
    planRefresh: ({ auto, decision }) => ({ skip: Boolean(auto && !decision.refresh), publish: Boolean(decision.real) }),
    backoffDelay: (interval) => interval,
    setTimeout: () => assert.fail('watch --once must not schedule a real timer'),
    publishBundle: async (actualRoot, actualProject, actualBundle) => {
      assert.equal(actualRoot, root);
      assert.equal(actualProject.id, ID);
      // Capture persisted pending state BEFORE this mocked network operation.
      events.push({ type: 'publish', hash: actualBundle.hashes.facts, bundle: copy(actualBundle), state: state() });
      let outcome = publications.length ? publications.shift() : 'published';
      if (typeof outcome === 'function') outcome = await outcome(actualBundle, f);
      if (outcome instanceof Error) throw outcome;
      if (outcome && typeof outcome === 'object') return copy(outcome);
      return { status: outcome, hash: actualBundle.hashes.facts, commit: COMMIT, parent: '1'.repeat(40) };
    },
    send: (res, code, body) => { res.code = code; res.body = copy(body); return res; },
  }, { codeGeneration: { strings: false, wasm: false } });
  new Script(`${refreshBody}\n${retryBody}`, { filename: 'isolated-refresh-entrypoints.vm.mjs' })
    .runInContext(context, { timeout: 1000 });
  f.count = count;
  f.publishes = () => events.filter((event) => event.type === 'publish');
  f.server = async (auto) => {
    context.__response = {};
    await new Script('handleRefresh(__response, getProject().id, __auto)').runInContext(
      Object.assign(context, { __auto: auto }), { timeout: 1000 },
    );
    assert.equal(context.refreshing.size, 0, 'handleRefresh must release its in-flight lock');
    return context.__response;
  };
  f.cli = async (flags = {}) => {
    fakeProcess.exitCode = 0;
    context.flags = { once: true, 'no-interpret': true, ...flags };
    context.rest = [ID];
    await new Script(`(async () => {\n${watchBody}\n})()`, { filename: 'isolated-watch-branch.vm.mjs' })
      .runInContext(context, { timeout: 1000 });
    return { exitCode: fakeProcess.exitCode, logs: [...logs] };
  };
  f.retry = async (value, signature = SIG_A) => {
    context.__bundle = value;
    context.__signature = signature;
    return new Script('publishWithRetry(root, getProject(), __bundle, __signature, console.log)')
      .runInContext(context, { timeout: 1000 });
  };
  return f;
}

function attachProbeRemote(f, { files = [`.pm/${ID}/manifest.json`] } = {}) {
  const base = '1'.repeat(40);
  f.head = base;
  f.requests = [];
  f.request = async (endpoint) => {
    f.requests.push(endpoint);
    if (endpoint === 'graphql') return { data: { repository: {
      nameWithOwner: f.project.repo,
      entries: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } };
    const url = new URL(`https://fixture.invalid/${endpoint}`);
    const rel = url.pathname.replace(`/repos/${f.project.repo}`, '');
    if (!rel) return { pushed_at: f.head === base ? NOW : '2026-11-20T10:01:00.000Z', default_branch: 'main' };
    if (rel === '/branches') return [{ name: 'main', commit: { sha: f.head } }];
    if (rel === `/compare/${base}...${COMMIT}`) return {
      status: 'ahead', total_commits: 1, merge_base_commit: { sha: base },
      commits: [{ sha: COMMIT, commit: { message: '[PM] confirmed bundle' }, parents: [{ sha: base }] }],
    };
    if (rel === `/commits/${COMMIT}`) return {
      sha: COMMIT, parents: [{ sha: base }], files: files.map((filename) => ({ filename })),
    };
    assert.fail(`unexpected isolated probe request: ${endpoint}`);
  };
}

function assertPublished(f, hash = A, signature = SIG_A) {
  const state = f.state();
  assert.ok(!state.pendingPublish, 'successful publish must clear pending');
  assert.equal(state.auditedHash, hash, 'audit watermark must describe the actual final bundle');
  assert.equal(state.publishedHash, hash, 'publish watermark must describe the actual final bundle');
  assert.equal(state.auditedSignature, signature);
  assert.equal(state.publishedSignature, signature);
}

function assertPendingAtNetwork(event, hash, signature = SIG_A) {
  assert.ok(event.state, 'persist pending state before the network call');
  assert.equal(event.hash, hash);
  assert.equal(event.state.pendingPublish?.hash, hash, 'persist the actual pending hash before the network call');
  assert.equal(event.state.pendingPublish?.signature, signature);
  assert.equal(typeof event.state.pendingPublish?.attemptId, 'string');
  assert.ok(event.state.pendingPublish.attemptId.length > 0, 'pending publication needs a durable attempt identity');
  assert.ok(event.state.pendingPublish.attempts > 0, 'count the publication attempt before the network call');
}

for (const auto of [true, false]) {
  const mode = auto ? 'auto' : 'manual';
  for (const outcome of ['published', 'same']) {
    test(`server ${mode}: pending + confirmed unchanged + same hash retries without duplicate audit (${outcome})`, async (t) => {
      const f = fixture(t, 'server', { publications: [outcome] });
      const response = await f.server(auto);
      assert.equal(response.code, 200, JSON.stringify(response.body));
      assert.equal(f.count('audit'), 0, 'matching pending bundle must not be audited again');
      assert.equal(f.count('interpret'), 0, 'publish-only recovery must not interpret commits');
      assert.equal(f.count('publish'), 1, 'unchanged remote must not suppress authorized pending retry');
      assertPendingAtNetwork(f.publishes()[0], A);
      assert.equal(response.body.publish.status, outcome);
      assertPublished(f);
    });
  }

  test(`server ${mode}: pending A with local B re-audits and publishes the actual new bundle`, async (t) => {
    const fresh = bundle(B, 'fresh-audit-B');
    const f = fixture(t, 'server', { bundle: bundle(B, 'stale-local-B'), audits: [fresh] });
    const response = await f.server(auto);
    assert.equal(response.code, 200, JSON.stringify(response.body));
    assert.equal(f.count('audit'), 1, 'pending/local hash mismatch requires a new audit');
    assert.equal(f.count('publish'), 1);
    const published = f.publishes()[0];
    assert.deepEqual(published.bundle, fresh, 'do not publish the stale pre-audit load');
    assertPendingAtNetwork(published, B);
    assert.equal(published.state.auditedHash, B, 'record successful B audit before publication');
    assert.ok(f.events.findIndex((event) => event.type === 'audit') < f.events.findIndex((event) => event.type === 'publish'));
    assert.equal(response.body.hash, B);
    assertPublished(f, B);
  });

  test(`server ${mode}: first publish fails, identical next probe recovers without another audit`, async (t) => {
    const f = fixture(t, 'server', {
      state: null, audits: [bundle(A, 'first-audit')],
      publications: [new Error('fixture network offline'), 'published'],
    });
    const first = await f.server(auto);
    assert.equal(first.body.publish?.status, 'error', JSON.stringify(first.body));
    assert.equal(f.count('audit'), 1);
    const failed = f.state();
    assert.equal(failed.pendingPublish?.hash, A);
    assert.ok(failed.pendingPublish.attempts > 0);
    assert.notEqual(failed.publishedHash, A, 'failed publication must not advance publish watermark');
    const second = await f.server(auto);
    assert.equal(second.code, 200, JSON.stringify(second.body));
    assert.equal(f.count('audit'), 1, 'the second identical probe must only retry publishing');
    assert.equal(f.count('publish'), 2);
    assert.equal(second.body.publish.status, 'published');
    assertPublished(f);
  });

  test(`server ${mode}: non-admin is sync-only even with pending publication`, async (t) => {
    const initial = baseline();
    const f = fixture(t, 'server', { admin: false, state: initial, probe: probe(SIG_B) });
    const response = await f.server(auto);
    assert.equal(response.code, 200, JSON.stringify(response.body));
    assert.equal(response.body.readOnly, true);
    assert.equal(f.count('sync'), 1);
    assert.equal(f.count('audit'), 0);
    assert.equal(f.count('publish'), 0);
    assert.equal(f.count('interpret'), 0);
    assert.equal(f.count('probe'), 0, 'read-only entry must short-circuit to sync');
    assert.equal(f.count('confirm'), 0);
    assert.deepEqual(f.state(), initial, 'sync-only must not consume an admin pending task');
  });

  for (const status of ['invalid', 'untrusted']) {
    test(`server ${mode}: read-only ${status} sync reports failure and preserves pending`, async (t) => {
      const initial = baseline();
      const f = fixture(t, 'server', {
        admin: false, state: initial,
        syncResult: { status, ...(status === 'invalid' ? { error: 'fixture verification failed' } : {}) },
      });
      const response = await f.server(auto);
      assert.equal(response.code, 502);
      assert.equal(response.body.ok, false);
      assert.equal(response.body.readOnly, true);
      assert.equal(response.body.sync.status, status);
      assert.match(response.body.error, /只读同步失败/);
      assert.equal(f.count('sync'), 1);
      for (const action of ['confirm', 'probe', 'audit', 'interpret', 'publish']) assert.equal(f.count(action), 0);
      assert.deepEqual(f.state(), initial);
    });
  }

  test(`server ${mode}: failed audit advances observation but not audit/publish watermarks`, async (t) => {
    const initial = baseline({ pending: false });
    const f = fixture(t, 'server', { state: initial, probe: probe(SIG_B), audits: [new Error('fixture audit failure')] });
    const response = await f.server(auto);
    assert.equal(response.code, 500);
    assert.match(response.body.error, /fixture audit failure/);
    assert.equal(f.count('audit'), 1);
    assert.equal(f.count('publish'), 0);
    const after = f.state();
    assert.equal(after.observedSignature, SIG_B, 'persist the observed probe even when audit fails');
    assert.deepEqual(after.observedProbe, probe(SIG_B));
    for (const key of ['auditedHash', 'auditedSignature', 'auditedProbe', 'publishedHash', 'publishedSignature']) {
      assert.deepEqual(after[key], initial[key], `failed audit must preserve ${key}`);
    }
    assert.ok(!after.pendingPublish, 'failed audit must not create publishable work');
  });
}

for (const outcome of ['published', 'same']) {
  test(`CLI watch: pending + confirmed unchanged + same hash retries without audit (${outcome})`, async (t) => {
    const f = fixture(t, 'cli', { publications: [outcome] });
    const run = await f.cli({ publish: true, 'no-interpret': false });
    assert.equal(run.exitCode, 0, run.logs.join('\n'));
    assert.equal(f.count('audit'), 0, 'matching pending bundle needs only publication');
    assert.equal(f.count('interpret'), 0);
    assert.equal(f.count('publish'), 1);
    assertPendingAtNetwork(f.publishes()[0], A);
    assertPublished(f);
  });
}

test('CLI watch: pending A with local B audits once and publishes the fresh B package', async (t) => {
  const fresh = bundle(B, 'fresh-audit-B');
  const f = fixture(t, 'cli', { bundle: bundle(B, 'stale-local-B'), audits: [fresh] });
  const run = await f.cli({ publish: true });
  assert.equal(run.exitCode, 0, run.logs.join('\n'));
  assert.equal(f.count('audit'), 1);
  assert.equal(f.count('publish'), 1);
  assert.deepEqual(f.publishes()[0].bundle, fresh);
  assertPendingAtNetwork(f.publishes()[0], B);
  assert.equal(f.publishes()[0].state.auditedHash, B);
  assertPublished(f, B);
});

test('CLI watch: non-admin --publish is sync-only and preserves pending', async (t) => {
  const initial = baseline();
  const f = fixture(t, 'cli', { admin: false, state: initial, probe: probe(SIG_B) });
  const run = await f.cli({ publish: true, 'no-interpret': false });
  assert.equal(run.exitCode, 0, run.logs.join('\n'));
  assert.equal(f.count('publish'), 0, 'non-admin --publish must never call the publisher');
  assert.equal(f.count('sync'), 1);
  assert.equal(f.count('audit'), 0);
  assert.equal(f.count('interpret'), 0);
  assert.equal(f.count('probe'), 0);
  assert.equal(f.count('confirm'), 0);
  assert.deepEqual(f.state(), initial);
});

for (const status of ['invalid', 'untrusted']) {
  test(`CLI watch --once: read-only ${status} sync fails without consuming pending`, async (t) => {
    const initial = baseline({ failures: 3 });
    const f = fixture(t, 'cli', {
      admin: false, state: initial,
      syncResult: { status, ...(status === 'invalid' ? { error: 'fixture verification failed' } : {}) },
    });
    const run = await f.cli({ publish: true, 'no-interpret': false });
    assert.equal(run.exitCode, 1);
    assert.equal(f.count('sync'), 1);
    for (const action of ['confirm', 'probe', 'audit', 'interpret', 'publish']) assert.equal(f.count(action), 0);
    const after = f.state();
    assert.equal(after.failures, 4);
    assert.match(after.lastError, /只读同步失败/);
    for (const key of ['pendingPublish', 'auditedHash', 'auditedSignature', 'publishedHash', 'publishedSignature']) {
      assert.deepEqual(after[key], initial[key], `read-only sync must preserve ${key}`);
    }
  });
}

test('CLI watch: successful read-only sync resets failures without consuming pending', async (t) => {
  const initial = baseline({ failures: 3 });
  initial.lastError = 'previous sync failure';
  const f = fixture(t, 'cli', { admin: false, state: initial });
  const run = await f.cli({ publish: true });
  assert.equal(run.exitCode, 0);
  assert.equal(f.state().failures, 0);
  assert.equal(f.state().lastError, null);
  for (const key of ['pendingPublish', 'auditedHash', 'auditedSignature', 'publishedHash', 'publishedSignature']) {
    assert.deepEqual(f.state()[key], initial[key]);
  }
  assert.equal(f.count('sync'), 1);
  for (const action of ['confirm', 'probe', 'audit', 'interpret', 'publish']) assert.equal(f.count(action), 0);
});

for (const signature of [SIG_A, SIG_B]) {
  test(`CLI watch: without --publish, ${signature} never publishes and retains pending`, async (t) => {
    const initial = baseline();
    const f = fixture(t, 'cli', {
      state: initial, probe: probe(signature), audits: [bundle(B, 'local-only-B')],
    });
    const run = await f.cli();
    assert.equal(run.exitCode, 0, run.logs.join('\n'));
    assert.equal(f.count('publish'), 0);
    assert.equal(f.count('confirm'), 0);
    assert.deepEqual(f.state().pendingPublish, initial.pendingPublish);
    assert.equal(f.state().publishedHash, initial.publishedHash);
    assert.equal(f.state().publishedSignature, initial.publishedSignature);
  });
}

test('CLI watch --once: publish failure returns nonzero and increments consecutive failures', async (t) => {
  const initial = baseline({ failures: 3 });
  const f = fixture(t, 'cli', { state: initial, publications: [new Error('fixture network offline')] });
  // Force this tick to publish even in the pre-pending implementation, so its
  // failure is an exit-code/counter assertion rather than an unexercised path.
  const run = await f.cli({ publish: true, fresh: true });
  assert.equal(f.count('audit'), 1);
  assert.equal(f.count('publish'), 1);
  assert.notEqual(run.exitCode, 0, 'watch --once must expose failed publication to its caller');
  const after = f.state();
  assert.equal(after.failures, 4, 'publication failure is a failed tick, not a success');
  assert.equal(after.pendingPublish.hash, A);
  assert.ok(after.pendingPublish.attempts > initial.pendingPublish.attempts);
  assert.match(after.pendingPublish.lastError, /fixture network offline/);
  assert.equal(after.publishedHash, PREVIOUS);
});

test('CLI watch: first publish fails, identical next probe recovers without another audit', async (t) => {
  const f = fixture(t, 'cli', {
    state: null, audits: [bundle(A, 'first-audit')],
    publications: [new Error('fixture network offline'), 'published'],
  });
  const first = await f.cli({ publish: true });
  assert.equal(f.count('audit'), 1);
  assert.equal(f.state().pendingPublish?.hash, A);
  assert.notEqual(f.state().publishedHash, A);
  const second = await f.cli({ publish: true });
  assert.equal(second.exitCode, 0, second.logs.join('\n'));
  assert.equal(f.count('audit'), 1, 'pending recovery must not re-audit an unchanged successful audit');
  assert.equal(f.count('publish'), 2);
  assert.notEqual(first.exitCode, 0);
  assert.equal(f.state().failures, 0, 'successful recovery resets consecutive failures');
  assertPublished(f);
});

function conflict() {
  return Object.assign(new Error('fixture remote changed'), { code: 'CONFLICT' });
}

for (const mode of ['server-auto', 'server-manual', 'cli']) {
  const kind = mode === 'cli' ? 'cli' : 'server';
  test(`${mode}: actual probe classifies a lost-ack commit as own only after pending reconciliation`, async (t) => {
    const f = fixture(t, kind, {
      state: null, realProbe: true, audits: [bundle(A, 'first-audit')],
      publications: [(target, fixture) => {
        fixture.head = COMMIT;
        fixture.confirmation = { status: 'confirmed', hash: target.hashes.facts, commit: COMMIT, parent: '1'.repeat(40) };
        return new Error('fixture remote PATCH succeeded but acknowledgement lost');
      }],
    });
    attachProbeRemote(f);
    const tick = () => kind === 'cli'
      ? f.cli({ publish: true, 'no-interpret': false }) : f.server(mode === 'server-auto');
    await tick();
    assert.equal(f.count('audit'), 1);
    assert.equal(f.count('interpret'), 1);
    assert.equal(f.count('publish'), 1);
    const failed = f.state();
    assert.equal(failed.pendingPublish.hash, A);
    assert.equal(failed.failures, 1);
    assert.ok(!failed.publishedCommit);
    const unknownOwn = await watchApi.probeRemote(f.project, { prevProbe: failed.auditedProbe, request: f.request });
    assert.equal(watchApi.classifyProbe({ prevProbe: failed.auditedProbe, nextProbe: unknownOwn, projectId: ID }).changed, true);
    for (let i = 0; i < 2; i++) {
      f.confirmation = new Error('fixture confirmation transport failure');
      await tick();
      assert.equal(f.state().pendingPublish.attemptId, failed.pendingPublish.attemptId);
      assert.equal(f.state().pendingPublish.attempts, failed.pendingPublish.attempts);
      assert.equal(f.state().failures, i + 2);
      assert.equal(f.count('probe'), 1, 'failed confirmation must stop before the normal probe');
    }
    f.confirmation = { status: 'confirmed', hash: A, commit: COMMIT, parent: '1'.repeat(40) };
    f.api.writeState(f.root, ID, kind, { ...f.state(), tickCount: 5 });
    const recovered = await tick();
    assert.equal(kind === 'cli' ? recovered.exitCode : recovered.code, kind === 'cli' ? 0 : 200);
    assert.equal(f.count('audit'), 1, 'confirmation must not trigger another audit, including the scheduled full tick');
    assert.equal(f.count('interpret'), 1);
    assert.equal(f.count('publish'), 1, 'do not publish again to obtain an acknowledgement');
    assert.equal(f.state().pendingPublish, undefined);
    assert.equal(f.state().publishedHash, A);
    assert.equal(f.state().publishedCommit, COMMIT);
    assert.equal(f.state().publishedParent, '1'.repeat(40));
    assert.equal(f.state().publishedSignature, failed.auditedSignature);
    assert.equal(f.state().failures, 0);
    assert.equal(f.state().lastError, null);
    assert.ok(f.events.filter((event) => event.type === 'probe').at(-1).knownOwn.includes(COMMIT));
    assert.ok(f.requests.some((request) => request.includes(`/commits/${COMMIT}?`)), 'actual probe validates commit scope after SHA registration');
    const confirmedProbe = await watchApi.probeRemote(f.project, {
      prevProbe: f.state().auditedProbe, knownOwn: f.api.knownOwnCommits(f.state()), request: f.request,
    });
    assert.equal(watchApi.classifyProbe({
      prevProbe: f.state().auditedProbe, nextProbe: confirmedProbe,
      knownOwn: f.api.knownOwnCommits(f.state()), projectId: ID,
    }).ownOnly, true);
    if (mode !== 'server-manual') {
      await tick();
      await tick();
      assert.equal(f.count('publish'), 1);
      assert.equal(f.count('audit'), 1);
      assert.equal(f.count('interpret'), 1);
    }
  });

  for (const confirmation of [new Error('fixture confirmation offline'), { status: 'invalid' }, { status: 'untrusted' },
    { status: 'confirmed', hash: B, commit: COMMIT, parent: '1'.repeat(40) }]) {
    test(`${mode}: failed confirmation preserves pending and increments failures before any probe`, async (t) => {
      const initial = baseline({ failures: 2 });
      const f = fixture(t, kind, { state: initial, confirmation });
      const result = kind === 'cli' ? await f.cli({ publish: true }) : await f.server(mode === 'server-auto');
      assert.equal(kind === 'cli' ? result.exitCode : result.code, kind === 'cli' ? 1 : 500);
      assert.equal(f.state().failures, 3);
      assert.equal(f.count('confirm'), 1);
      for (const action of ['probe', 'audit', 'interpret', 'publish', 'sync']) assert.equal(f.count(action), 0);
      for (const key of ['hash', 'attemptId', 'attempts', 'signature']) {
        assert.equal(f.state().pendingPublish[key], initial.pendingPublish[key]);
      }
      assert.equal(f.state().publishedHash, PREVIOUS);
      assert.equal(f.state().auditedSignature, SIG_A);
    });
  }

  test(`${mode}: post-conflict failure retries pending B next tick without another audit`, async (t) => {
    const f = fixture(t, kind, {
      audits: [bundle(B, 'conflict-audit')],
      publications: [conflict(), new Error('fixture B publish failed'), 'same'],
    });
    const tick = () => kind === 'cli' ? f.cli({ publish: true }) : f.server(mode === 'server-auto');
    await tick();
    assert.equal(f.count('audit'), 1);
    assert.equal(f.count('publish'), 2);
    const first = f.state();
    assert.equal(first.pendingPublish.hash, B);
    assert.equal(first.pendingPublish.signature, SIG_B);
    assert.equal(first.auditedSignature, SIG_B);
    assert.deepEqual(first.auditedProbe, probe(SIG_B));
    const syncAt = f.events.findIndex((event) => event.type === 'sync');
    const retryProbeAt = f.events.findIndex((event, index) => index > syncAt && event.type === 'probe');
    const auditAt = f.events.findIndex((event) => event.type === 'audit');
    assert.ok(syncAt < retryProbeAt && retryProbeAt < auditAt);
    await tick();
    assert.equal(f.count('audit'), 1);
    assert.equal(f.count('interpret'), 0);
    assert.equal(f.count('publish'), 3);
    assert.equal(f.publishes()[2].state.pendingPublish.attempts, first.pendingPublish.attempts + 1);
    assertPublished(f, B, SIG_B);
  });

  for (const conflictProbe of [new Error('fixture post-sync probe offline'), { ...probe(SIG_B), snapshotComplete: false }]) {
    test(`${mode}: failed or incomplete fresh conflict probe aborts before re-audit`, async (t) => {
      const f = fixture(t, kind, { conflictProbe, publications: [conflict()] });
      const result = kind === 'cli' ? await f.cli({ publish: true }) : await f.server(mode === 'server-auto');
      assert.equal(kind === 'cli' ? result.exitCode : result.body.ok, kind === 'cli' ? 1 : false);
      assert.equal(f.count('sync'), 1);
      assert.equal(f.count('probe'), 2);
      assert.equal(f.count('audit'), 0);
      assert.equal(f.count('publish'), 1);
      assert.equal(f.state().pendingPublish.hash, A);
      assert.equal(f.state().pendingPublish.signature, SIG_A);
      assert.equal(f.state().auditedSignature, SIG_A);
      assert.equal(f.state().publishedHash, PREVIOUS);
      assert.equal(f.state().failures, 1);
    });
  }
}

for (const auto of [true, false]) {
  for (const outcome of ['published', 'same', 'error']) {
    test(`server conflict auto=${auto}: retries once with actual B (${outcome})`, async (t) => {
      const fresh = bundle(B, 'server-conflict-B');
      const f = fixture(t, 'server', {
        audits: [fresh], publications: [conflict(), outcome === 'error' ? conflict() : outcome],
      });
      const response = await f.server(auto);
      assert.equal(f.count('sync'), 1);
      assert.equal(f.count('audit'), 1);
      assert.equal(f.count('publish'), 2);
      assert.equal(response.body.hash, B);
      assert.equal(response.body.publish.status, outcome);
      assert.deepEqual(f.publishes()[1].bundle, fresh);
      assertPendingAtNetwork(f.publishes()[1], B, SIG_B);
      if (outcome === 'error') {
        assert.equal(response.body.ok, false);
        assert.equal(f.state().pendingPublish.hash, B);
        assert.equal(f.state().failures, 1);
        assert.equal(f.state().publishedHash, PREVIOUS);
      } else assertPublished(f, B, SIG_B);
    });
  }
}

for (const kind of ['server', 'cli']) {
  test(`${kind}: confirmed pending identity does not hide out-of-scope changes from the actual classifier`, async (t) => {
    const f = fixture(t, kind, {
      realProbe: true, audits: [bundle(B, 'source-change-audit')],
      confirmation: { status: 'confirmed', hash: A, commit: COMMIT, parent: '1'.repeat(40) },
    });
    attachProbeRemote(f, { files: [`.pm/${ID}/manifest.json`, 'src/work.js'] });
    const previous = await watchApi.probeRemote(f.project, { request: f.request });
    f.api.writeState(f.root, ID, kind, {
      ...f.state(), auditedProbe: previous, auditedSignature: watchApi.signatureOf(previous),
    });
    f.head = COMMIT;
    const result = kind === 'server' ? await f.server(true) : await f.cli({ publish: true });
    assert.equal(kind === 'server' ? result.body.ok : result.exitCode, kind === 'server' ? true : 0);
    assert.equal(f.count('confirm'), 1);
    assert.equal(f.count('audit'), 1);
    assert.equal(f.count('publish'), 1);
    assert.equal(f.publishes()[0].hash, B);
    assert.ok(f.events.find((event) => event.type === 'probe').knownOwn.includes(COMMIT));
  });

  test(`${kind}: unstarted pending work is published without attempting remote reconciliation`, async (t) => {
    const initial = baseline();
    initial.pendingPublish.attemptId = null;
    initial.pendingPublish.attempts = 0;
    const f = fixture(t, kind, { state: initial, confirmation: new Error('must not confirm unstarted work') });
    const result = kind === 'server' ? await f.server(true) : await f.cli({ publish: true });
    assert.equal(kind === 'server' ? result.body.ok : result.exitCode, kind === 'server' ? true : 0);
    assert.equal(f.count('confirm'), 0);
    assert.equal(f.count('audit'), 0);
    assert.equal(f.count('publish'), 1);
    assert.equal(f.publishes()[0].state.pendingPublish.attempts, 1);
    assertPublished(f);
  });

  for (const status of ['invalid', 'untrusted']) {
    test(`${kind} conflict: rejected sync ${status} stops before retry`, async (t) => {
      const f = fixture(t, kind, { syncResult: { status }, publications: [conflict()] });
      const result = kind === 'server' ? await f.server(true) : await f.cli({ publish: true });
      assert.equal(kind === 'server' ? result.body.ok : result.exitCode === 0, false);
      assert.equal(f.count('sync'), 1);
      assert.equal(f.count('audit'), 0);
      assert.equal(f.count('publish'), 1);
      assert.equal(f.state().pendingPublish.hash, A);
      assert.equal(f.state().publishedHash, PREVIOUS);
    });
  }
  test(`${kind} unknown probe: no repeated audit or pending publication`, async (t) => {
    const initial = baseline();
    const f = fixture(t, kind, {
      state: initial, classification: { unknown: true, reason: 'fixture incomplete probe' },
    });
    for (let i = 0; i < 2; i++) {
      const result = kind === 'server' ? await f.server(true) : await f.cli({ publish: true });
      assert.equal(kind === 'server' ? result.code : result.exitCode, kind === 'server' ? 500 : 1);
    }
    assert.equal(f.count('audit'), 0);
    assert.equal(f.count('publish'), 0);
    assert.equal(f.state().failures, 2);
    assert.deepEqual(f.state().pendingPublish, initial.pendingPublish);
    assert.equal(f.state().auditedHash, A);
  });
}

test('CLI watch conflict: persist pending B before second network call; final audit and publish hashes are B', async (t) => {
  const fresh = bundle(B, 'conflict-re-audit-B');
  const f = fixture(t, 'cli', {
    state: null, audits: [bundle(A, 'initial-audit-A'), fresh],
    publications: [conflict(), 'published'],
  });
  const run = await f.cli({ publish: true });
  assert.equal(run.exitCode, 0, run.logs.join('\n'));
  assert.equal(f.count('sync'), 1);
  assert.equal(f.count('audit'), 2);
  assert.equal(f.count('publish'), 2);
  const [first, second] = f.publishes();
  assertPendingAtNetwork(first, A);
  // The conflict invalidates the pre-sync probe: B must not inherit A's signature.
  assertPendingAtNetwork(second, B, SIG_B);
  assert.notEqual(second.state.pendingPublish.attemptId, first.state.pendingPublish.attemptId,
    'B cannot reuse the pending attempt identity of A');
  assert.equal(second.state.auditedHash, B);
  assert.equal(second.state.auditedSignature, SIG_B);
  assert.deepEqual(second.state.auditedProbe, probe(SIG_B));
  assert.deepEqual(second.bundle, fresh);
  assertPublished(f, B, SIG_B);
});

for (const outcome of ['published', 'same', 'error']) {
  test(`CLI publishWithRetry: conflict returns the actual final B bundle (${outcome})`, async (t) => {
    const fresh = bundle(B, 'conflict-re-audit-B');
    const f = fixture(t, 'cli', {
      audits: [fresh],
      publications: [conflict(), outcome === 'error' ? new Error('fixture second network offline') : outcome],
    });
    const result = await f.retry(bundle(A));
    assert.equal(f.count('sync'), 1);
    assert.equal(f.count('audit'), 1);
    assert.equal(f.count('publish'), 2);
    assert.ok(result, 'publishWithRetry must return a structured result even after failure');
    assert.equal(result.status, outcome);
    assert.equal(result.hash, B);
    assert.equal(result.bundle, f.lastAuditBundle, 'return the actual re-audited bundle, not the original A');
    const [first, second] = f.publishes();
    assertPendingAtNetwork(first, A);
    assertPendingAtNetwork(second, B, SIG_B);
    assert.notEqual(second.state.pendingPublish.attemptId, first.state.pendingPublish.attemptId);
    assert.equal(second.state.auditedHash, B);
    assert.equal(second.state.auditedSignature, SIG_B);
    assert.deepEqual(second.state.auditedProbe, probe(SIG_B));
    if (outcome === 'error') {
      assert.equal(f.state().pendingPublish.hash, B);
      assert.match(f.state().pendingPublish.lastError, /fixture second network offline/);
      assert.equal(f.state().publishedHash, PREVIOUS);
    } else {
      assertPublished(f, B, SIG_B);
    }
  });
}

test('CLI watch: failed audit advances observation but preserves audit/publish watermarks', async (t) => {
  const initial = baseline({ pending: false });
  const f = fixture(t, 'cli', { state: initial, probe: probe(SIG_B), audits: [new Error('fixture audit failure')] });
  const run = await f.cli({ publish: true });
  assert.ok(run.logs.some((line) => line.includes('fixture audit failure')), run.logs.join('\n'));
  assert.equal(f.count('audit'), 1);
  assert.equal(f.count('publish'), 0);
  const after = f.state();
  assert.equal(after.observedSignature, SIG_B, 'observation and successful audit are different watermarks');
  assert.deepEqual(after.observedProbe, probe(SIG_B));
  for (const key of ['auditedHash', 'auditedSignature', 'auditedProbe', 'publishedHash', 'publishedSignature']) {
    assert.deepEqual(after[key], initial[key], `failed audit must preserve ${key}`);
  }
  assert.ok(!after.pendingPublish);
});
