import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import { publishPending, reconcilePending, readState, knownOwnCommits } from '../src/refresh-state.mjs';

// Evaluate complete modules with an explicit dependency allowlist. Never import
// gh, identity, project, server, CLI, or model code; all mutable files are OS-temp.
const repo = fileURLToPath(new URL('../', import.meta.url));
const sources = Object.fromEntries([
  'src/remote.mjs', 'src/bundle.mjs', 'src/facts.mjs', 'src/canonical.mjs',
  'src/brand.mjs', 'src/render.mjs', 'src/project-lock.mjs', 'test/lib/fixture.mjs',
].map((file) => [file, fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n')]));
const BASE = 'a'.repeat(40);
const BASE_TREE = 'b'.repeat(40);
const NEXT = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const AUTHOR_COMMIT = 'e'.repeat(40);
const PREFIX = '.pm/demo/';
const MANIFEST = `${PREFIX}manifest.json`;
const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const http = (status) => new Error(`gh GET fixture 失败: Not Found (HTTP ${status})`);
const noService = () => assert.fail('unmocked service invocation');

function evaluate(file, imports = {}, globals = {}) {
  const source = sources[file];
  const names = [...source.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/g)].map((m) => m[1]);
  const expanded = source.replace(/\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g, (_, bindings, specifier) => {
    assert.ok(Object.hasOwn(imports, specifier), `unmocked dependency ${file}: ${specifier}`);
    return `const ${bindings.trim().replace(/\b(\w+)\s+as\s+(\w+)\b/g, '$1: $2')} = __imports[${JSON.stringify(specifier)}];`;
  }).replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/g, '');
  const context = createContext({ __imports: imports, Buffer, console: { log: noService }, ...globals }, {
    codeGeneration: { strings: false, wasm: false },
  });
  return new Script(`${expanded}\n;({ ${names.join(', ')} });`, { filename: path.join(repo, file) })
    .runInContext(context, { timeout: 1000 });
}

const canonical = evaluate('src/canonical.mjs', { 'node:crypto': crypto });
const facts = evaluate('src/facts.mjs');
const brand = evaluate('src/brand.mjs', { './canonical.mjs': canonical });
const render = evaluate('src/render.mjs', { './brand.mjs': brand });
const samples = evaluate('test/lib/fixture.mjs');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'pm-remote-flow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = samples.sampleProject({ repo: 'fixture/never-contact', defaultBranch: 'release/test' });
  const lockRel = path.join('cache', project.id, 'project.lock');
  const localWrites = [];
  const hooks = { rename: null, failRename: null };
  const inside = (file) => {
    const relative = path.relative(root, path.resolve(String(file)));
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
      `filesystem access outside OS fixture: ${file}`);
    return relative;
  };
  // The real lock module runs against this facade, so lock bookkeeping is
  // guarded but not counted as an audit write.
  const guardedFs = {
    readFileSync: (file, ...args) => { inside(file); return fs.readFileSync(file, ...args); },
    existsSync: (file) => { inside(file); return fs.existsSync(file); },
    readdirSync: (file, ...args) => { inside(file); return fs.readdirSync(file, ...args); },
    mkdirSync: (file, ...args) => { inside(file); return fs.mkdirSync(file, ...args); },
    openSync: (file, ...args) => { inside(file); return fs.openSync(file, ...args); },
    closeSync: (...args) => fs.closeSync(...args),
    fsyncSync: (...args) => fs.fsyncSync(...args),
    writeFileSync: (file, ...args) => {
      if (typeof file === 'string') {
        const relative = inside(file);
        if (relative !== lockRel) localWrites.push({ name: 'writeFileSync', file: String(file) });
      }
      return fs.writeFileSync(file, ...args);
    },
    renameSync: (from, to) => {
      inside(from);
      const relative = inside(to);
      if (hooks.rename) hooks.rename(from, to);
      if (hooks.failRename && hooks.failRename(to)) {
        throw Object.assign(new Error('fixture rename failure'), { code: 'EIO' });
      }
      if (relative !== lockRel) localWrites.push({ name: 'renameSync', file: String(to) });
      return fs.renameSync(from, to);
    },
    unlinkSync: (file) => { inside(file); return fs.unlinkSync(file); },
    rmSync: (file, ...args) => { inside(file); return fs.rmSync(file, ...args); },
  };
  const alive = new Set([process.pid]);
  const projectProcess = {
    pid: process.pid, ppid: process.ppid,
    kill(pid, signal) {
      if (signal !== 0 || !alive.has(pid)) {
        throw Object.assign(new Error(`fixture process ${pid} is not alive`), { code: 'ESRCH' });
      }
      return true;
    },
  };
  const projectLock = evaluate('src/project-lock.mjs', {
    'node:fs': guardedFs, 'node:path': path, 'node:crypto': crypto,
  }, { process: projectProcess, Atomics, SharedArrayBuffer });
  const bundles = evaluate('src/bundle.mjs', {
    'node:fs': guardedFs, 'node:path': path, './canonical.mjs': canonical, './facts.mjs': facts,
    './project-lock.mjs': projectLock,
  });
  const makeBundle = (changed = false) => {
    const raw = samples.sampleRaw();
    if (changed) raw.issues.push({ number: 9, title: '[A4] Done', state: 'closed', body: '', updated_at: raw.fetchedAt });
    return copy(bundles.buildBundle(project, raw, facts.buildFacts(project.plan, raw, project, raw.fetchedAt)));
  };
  const bundle = makeBundle();
  const calls = [];
  const snapshots = new Map([[BASE, new Map()]]);
  const blobs = new Map();
  const commits = new Map([
    [BASE, { tree: { sha: BASE_TREE }, parents: [] }],
    [AUTHOR_COMMIT, { tree: { sha: BASE_TREE }, parents: [BASE] }],
  ]);
  let nextTree;
  const f = {
    root, project, bundle, bundles, makeBundle, calls, snapshots, blobs, localWrites, hooks,
    head: BASE, hook: null, authors: [{ sha: AUTHOR_COMMIT, author: { login: 'oCtO' }, commit: { author: { name: 'Fixture' } } }],
    bundleFile: path.join(root, 'data', project.id, 'bundle.pm.json'),
    publishedFile: path.join(root, 'cache', project.id, 'published.json'),
    lockFile: path.join(root, lockRel),
  };
  const ghJson = async (endpoint, opts = {}) => {
    const call = { endpoint, method: opts.method || 'GET', body: copy(opts.body) };
    calls.push(call);
    if (f.hook) {
      const result = await f.hook(call);
      if (result !== undefined) return result;
    }
    const url = new URL(`https://fixture.invalid/${endpoint}`);
    const rel = url.pathname.replace(`/repos/${project.repo}/`, '');
    if (call.method === 'GET') {
      if (rel.startsWith('git/ref/heads/')) return { object: { sha: f.head } };
      if (rel.startsWith('git/commits/')) {
        assert.ok(commits.has(rel.slice('git/commits/'.length)), 'commit read must use the captured SHA');
        const sha = rel.slice('git/commits/'.length);
        const commit = copy(commits.get(sha));
        return { ...commit, sha, parents: commit.parents.map((parent) => ({ sha: parent })) };
      }
      if (rel.startsWith('contents/')) {
        const requested = url.searchParams.get('ref');
        const sha = requested === project.defaultBranch ? f.head : requested;
        assert.ok(snapshots.has(sha), `unknown snapshot: ${requested}`);
        const files = snapshots.get(sha);
        const file = rel.slice('contents/'.length);
        if (!files.has(file)) throw http(404);
        return { encoding: 'base64', sha: crypto.createHash('sha1').update(files.get(file)).digest('hex'),
          content: Buffer.from(files.get(file)).toString('base64') };
      }
      if (rel === 'commits') return copy(f.authors);
      if (rel.startsWith('git/blobs/')) {
        const sha = rel.slice('git/blobs/'.length);
        assert.ok(blobs.has(sha), `unexpected blob: ${sha}`);
        return { encoding: 'base64', content: Buffer.from(blobs.get(sha)).toString('base64') };
      }
    }
    if (call.method === 'POST' && rel === 'git/blobs') {
      const sha = crypto.createHash('sha1').update(call.body.content).digest('hex');
      blobs.set(sha, call.body.content);
      return { sha };
    }
    if (call.method === 'POST' && rel === 'git/trees') {
      assert.equal(call.body.base_tree, BASE_TREE);
      nextTree = new Map(snapshots.get(BASE));
      for (const entry of call.body.tree) {
        if (entry.sha === null) nextTree.delete(entry.path);
        else {
          assert.ok(blobs.has(entry.sha));
          nextTree.set(entry.path, blobs.get(entry.sha));
        }
      }
      return { sha: 'f'.repeat(40) };
    }
    if (call.method === 'POST' && rel === 'git/commits') {
      assert.deepEqual(call.body.parents, [BASE]);
      commits.set(NEXT, { tree: { sha: call.body.tree }, parents: call.body.parents });
      snapshots.set(NEXT, nextTree);
      return { sha: NEXT };
    }
    if (call.method === 'PATCH' && rel.startsWith('git/refs/heads/')) {
      assert.equal(call.body.force, false, 'ref update must explicitly be nonforce');
      assert.equal(decodeURIComponent(rel.slice('git/refs/heads/'.length)), project.defaultBranch);
      if (commits.get(call.body.sha).parents[0] !== f.head) throw new Error('HTTP 422: Update is not a fast forward');
      f.head = call.body.sha;
      f.authors = [{ sha: f.head, author: { login: 'Octo' } }];
      return { object: { sha: f.head } };
    }
    assert.fail(`unexpected mocked GitHub call: ${call.method} ${endpoint}`);
  };
  f.api = evaluate('src/remote.mjs', {
    'node:fs': guardedFs, 'node:path': path, 'node:zlib': zlib, 'node:crypto': crypto,
    './gh.mjs': { ghJson }, './bundle.mjs': bundles, './canonical.mjs': canonical,
    './agent.mjs': {
      buildAgent: (p) => ({ readme: 'fixture readme', guide: 'fixture guide', index: { project: p.id },
        files: [{ path: `${PREFIX}agent/tasks/A1.md`, content: 'fixture task' }] }),
      writeAgentLocal: () => localWrites.push({ name: 'agent' }),
    },
    './trail.mjs': { renderTrail: () => 'fixture trail' },
    './identity.mjs': {
      detectIdentity: () => ({ login: options.admin === false ? 'reader' : 'Octo' }),
      isAdmin: () => options.admin !== false, adminDenied: () => 'fixture forbidden',
      adminList: () => options.noAdmins ? [] : ['Octo'],
    },
    './project.mjs': { createProject: noService, getProject: noService }, './brand.mjs': brand,
    './project-lock.mjs': projectLock,
  });
  f.seedLocal = (value = bundle) => {
    fs.mkdirSync(path.dirname(f.bundleFile), { recursive: true });
    fs.writeFileSync(f.bundleFile, typeof value === 'string' ? value : JSON.stringify(value));
  };
  f.localText = () => fs.readFileSync(f.bundleFile, 'utf8');
  f.writes = () => calls.filter((call) => call.method !== 'GET');
  f.publish = (value = bundle) => f.api.publishBundle(root, project, value, { log: () => {} });
  f.sync = () => f.api.syncFromRemote(root, project);
  f.confirm = (hash = bundle.hashes.facts) => f.api.confirmRemotePublish(project, hash);
  f.install = (value = bundle, layout = 'parts') => {
    const files = snapshots.get(BASE);
    files.clear();
    const gz = zlib.gzipSync(JSON.stringify(value));
    const b64 = gz.toString('base64');
    const descriptor = layout === 'parts' ? {
      format: 'gzip-base64-parts', parts: ['bundle.parts/00.b64', 'bundle.parts/01.b64'],
      sha256: crypto.createHash('sha256').update(gz).digest('hex'), bytes: gz.length,
    } : undefined;
    if (layout === 'parts') {
      const mid = Math.floor(b64.length / 8) * 4;
      files.set(`${PREFIX}${descriptor.parts[0]}`, b64.slice(0, mid));
      files.set(`${PREFIX}${descriptor.parts[1]}`, b64.slice(mid));
    } else if (layout === 'gzip') files.set(`${PREFIX}bundle.pm.json.gz`, b64);
    else files.set(`${PREFIX}bundle.pm.json`, JSON.stringify(value));
    const manifest = { format: 'pm-audit/remote', version: 1, project: project.id,
      hash: value.hashes.facts, asOf: value.asOf, files: {}, ...(descriptor ? { bundle: descriptor } : {}) };
    files.set(MANIFEST, JSON.stringify(manifest));
    return manifest;
  };
  f.setManifest = (manifest) => snapshots.get(BASE).set(MANIFEST, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return f;
}

function unchanged(f, before) {
  assert.equal(f.localText(), before, 'failed sync/publication must preserve the local bundle byte-for-byte');
  assert.equal(f.localWrites.length, 0, 'no local write or agent output on failure/same');
}

for (const layout of ['parts', 'gzip', 'json']) {
  test(`confirmation validates the full pinned ${layout} bundle and returns the manifest commit, not branch head`, async (t) => {
    const f = fixture(t);
    f.seedLocal('local bytes must never be repaired by confirmation');
    const before = f.localText();
    f.install(f.bundle, layout);
    f.snapshots.set(OTHER, new Map());
    f.hook = (call) => { if (call.endpoint.includes('manifest.json')) f.head = OTHER; };
    const result = await f.confirm();
    assert.deepEqual(copy(result), { status: 'confirmed', hash: f.bundle.hashes.facts, commit: AUTHOR_COMMIT, parent: BASE });
    assert.ok(f.calls.some((call) => call.endpoint.endsWith(`/git/commits/${AUTHOR_COMMIT}`)));
    assert.equal(f.calls.filter((call) => call.endpoint.includes('git/ref/heads/')).length, 1);
    for (const call of f.calls) {
      const url = new URL(`https://fixture.invalid/${call.endpoint}`);
      if (url.pathname.includes('/contents/')) assert.equal(url.searchParams.get('ref'), BASE);
      if (url.pathname.endsWith('/commits')) assert.equal(url.searchParams.get('sha'), BASE);
    }
    assert.equal(f.writes().length, 0);
    unchanged(f, before);
  });
}

for (const absent of [false, true]) {
  test(`confirmation explicitly returns ${absent ? 'absent' : 'not-match'} without writes`, async (t) => {
    const f = fixture(t);
    f.seedLocal();
    const before = f.localText();
    if (!absent) f.install(f.makeBundle(true));
    assert.equal((await f.confirm()).status, absent ? 'absent' : 'not-match');
    assert.equal(f.calls.length, 2);
    assert.equal(f.writes().length, 0);
    unchanged(f, before);
  });
}

for (const authors of [[], [{ sha: AUTHOR_COMMIT, author: null }],
  [{ sha: AUTHOR_COMMIT, author: { login: 'outsider' } }],
  [{ sha: AUTHOR_COMMIT, author: { login: ' ' } }], [{ author: { login: 'Octo' } }]]) {
  test(`confirmation never trusts hash or PM prefix without an approved author: ${JSON.stringify(authors)}`, async (t) => {
    const f = fixture(t);
    f.seedLocal();
    const before = f.localText();
    f.install();
    f.authors = authors;
    await assert.rejects(f.confirm(), { code: 'UNTRUSTED_REMOTE' });
    assert.equal(f.writes().length, 0);
    unchanged(f, before);
  });
}

test('confirmation requires a configured administrator trust anchor', async (t) => {
  const f = fixture(t, { noAdmins: true });
  f.install();
  await assert.rejects(f.confirm(), { code: 'UNTRUSTED_REMOTE' });
  assert.equal(f.localWrites.length, 0);
  assert.equal(f.writes().length, 0);
});

for (const detail of [null, {}, { sha: OTHER, parents: [{ sha: BASE }] },
  { sha: AUTHOR_COMMIT, parents: [] }, { sha: AUTHOR_COMMIT, parents: [{ sha: BASE }, { sha: OTHER }] },
  { sha: AUTHOR_COMMIT, parents: [{ sha: 'short' }] },
  { sha: AUTHOR_COMMIT, parents: [{ sha: AUTHOR_COMMIT }] }]) {
  test(`confirmation rejects incomplete manifest commit identity: ${JSON.stringify(detail)}`, async (t) => {
    const f = fixture(t);
    f.install();
    f.hook = (call) => call.endpoint.includes('/git/commits/') ? detail : undefined;
    await assert.rejects(f.confirm(), { code: 'INVALID_REMOTE_DATA' });
    assert.equal(f.localWrites.length, 0);
    assert.equal(f.writes().length, 0);
  });
}

for (const stage of ['git/ref/heads/', 'manifest.json', '/commits?', '/bundle.parts/', '/git/commits/']) {
  for (const error of [http(403), http(503), new Error('fixture lost confirmation response')]) {
    test(`confirmation fails closed on ${stage}: ${error.message}`, async (t) => {
      const f = fixture(t);
      f.seedLocal();
      const before = f.localText();
      f.install();
      f.hook = (call) => { if (call.endpoint.includes(stage)) throw error; };
      await assert.rejects(f.confirm(), (err) => err === error);
      assert.equal(f.writes().length, 0);
      unchanged(f, before);
    });
  }
}

for (const structured of [false, true]) {
  test(`first publish: only confirmed manifest 404 permits creation (${structured ? 'status' : 'gh message'})`, async (t) => {
    const f = fixture(t);
    if (structured) f.hook = (call) => {
      if (call.endpoint.includes('/contents/')) throw Object.assign(new Error('not found'), { status: 404 });
    };
    const result = await f.publish();
    assert.equal(result.status, 'published');
    assert.equal(result.commit, NEXT);
    assert.equal(result.parent, BASE);
    assert.equal(result.baseSha, BASE);
    assert.equal(result.baseTreeSha, BASE_TREE);
    assert.equal(f.head, NEXT);
    const manifestRead = f.calls.find((call) => call.endpoint.includes('/contents/'));
    assert.ok(manifestRead.endpoint.endsWith(`?ref=${BASE}`));
    assert.equal(f.calls.filter((call) => call.endpoint.includes('/git/ref/heads/')).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(f.publishedFile, 'utf8')).commit, NEXT);
  });
}

for (const error of [http(401), http(403), http(429), http(503), new Error('socket timeout'),
  new SyntaxError('Unexpected token in GitHub JSON'), new SyntaxError('Unexpected token HTTP 404 in JSON'),
  new Error('socket failed on route /404/'), Object.assign(new Error('HTTP 404 in response details'), { status: 403 })]) {
  test(`publish manifest failure preserves original error and writes nothing: ${error.message}`, async (t) => {
    const f = fixture(t);
    f.hook = (call) => { if (call.endpoint.includes('/contents/')) throw error; };
    await assert.rejects(f.publish(), (err) => err === error);
    assert.equal(f.writes().length, 0);
    assert.equal(f.localWrites.length, 0);
  });
}

for (const target of ['git/ref/heads/', 'git/commits/']) {
  test(`publish snapshot transport error is not relabeled CONFLICT: ${target}`, async (t) => {
    const f = fixture(t);
    const error = Object.assign(http(503), { code: 'SERVICE_UNAVAILABLE' });
    f.hook = (call) => { if (call.endpoint.includes(target)) throw error; };
    await assert.rejects(f.publish(), (err) => err === error && err.code !== 'CONFLICT');
    assert.equal(f.writes().length, 0);
    assert.equal(f.localWrites.length, 0);
  });
}

test('publish rejects incomplete snapshot before malformed commit lookup or writes', async (t) => {
  const f = fixture(t);
  f.hook = (call) => call.endpoint.includes('git/ref/heads/') ? { object: { sha: 'short' } } : undefined;
  await assert.rejects(f.publish(), { code: 'CONFLICT' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.writes().length, 0);
});

for (const [label, mutate] of [
  ['JSON', () => '{broken'], ['null', () => 'null'], ['empty object', () => ({})],
  ['project', (m) => ({ ...m, project: 'another' })], ['hash', (m) => ({ ...m, hash: null })],
  ['timestamp', (m) => ({ ...m, asOf: 'invalid' })], ['files', (m) => ({ ...m, files: [] })],
  ['empty descriptor', (m) => ({ ...m, bundle: {} })],
  ['missing parts', (m) => ({ ...m, bundle: { format: 'gzip-base64-parts' } })],
  ['empty parts', (m) => ({ ...m, bundle: { ...m.bundle, parts: [] } })],
  ['escaping part', (m) => ({ ...m, bundle: { ...m.bundle, parts: ['../other/00.b64'] } })],
  ['query in part', (m) => ({ ...m, bundle: { ...m.bundle, parts: ['00.b64?ref=main'] } })],
]) {
  test(`malformed manifest ${label}: publish aborts; sync is invalid and preserves local`, async (t) => {
    const f = fixture(t);
    f.seedLocal();
    const before = f.localText();
    f.setManifest(mutate(f.install()));
    await assert.rejects(f.confirm(), { code: 'INVALID_REMOTE_DATA' });
    await assert.rejects(f.publish(), { code: 'INVALID_REMOTE_DATA' });
    assert.equal((await f.sync()).status, 'invalid');
    assert.equal(f.writes().length, 0);
    unchanged(f, before);
  });
}

for (const payload of [null, {}, [], { encoding: 'base64', content: '**not-base64**' }]) {
  test(`successful HTTP with malformed contents is not absence: ${JSON.stringify(payload)}`, async (t) => {
    const f = fixture(t);
    f.hook = (call) => call.endpoint.includes('/contents/') ? payload : undefined;
    await assert.rejects(f.publish(), { code: 'INVALID_REMOTE_DATA' });
    assert.equal((await f.sync()).status, 'invalid');
    assert.equal(f.writes().length, 0);
  });
}

for (const [label, mutate] of [
  ['legacy', (b) => { b.version = 1; }], ['unsupported', (b) => { b.version = 999; }],
  ['tampered facts', (b) => { b.facts.nodes[0].state = 'ready'; }],
  ['project id', (b) => { b.project.id = 'other'; }],
  ['repository', (b) => { b.project.repo = 'other/repo'; }],
  ['missing timestamp', (b) => { delete b.asOf; }],
]) {
  test(`publish validates ${label} before any remote request or write`, async (t) => {
    const f = fixture(t);
    const value = copy(f.bundle);
    mutate(value);
    await assert.rejects(f.publish(value));
    assert.equal(f.calls.length, 0);
    assert.equal(f.localWrites.length, 0);
  });
}

test('non-admin publish has no GitHub or filesystem effects', async (t) => {
  const f = fixture(t, { admin: false });
  await assert.rejects(f.publish(), { code: 'FORBIDDEN' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.localWrites.length, 0);
});

test('idempotent second publish returns same and snapshot metadata with zero writes', async (t) => {
  const f = fixture(t);
  await f.publish();
  const before = fs.readFileSync(f.publishedFile, 'utf8');
  f.calls.length = 0;
  f.localWrites.length = 0;
  const result = await f.publish();
  assert.equal(result.status, 'same');
  assert.equal(result.commit, NEXT);
  assert.equal(result.parent, NEXT);
  assert.equal(result.baseSha, NEXT);
  assert.equal(result.baseTreeSha, 'f'.repeat(40));
  assert.equal(f.writes().length, 0);
  assert.equal(f.localWrites.length, 0);
  assert.equal(fs.readFileSync(f.publishedFile, 'utf8'), before);
});

test('publish prunes only canonical own-project paths; foreign manifest entries confer no authority', async (t) => {
  const f = fixture(t);
  const manifest = f.install();
  const foreign = ['README.md', '.pm/other/private.md', '.pm/demo-other/old.md', '.pm/demo/../other/old.md',
    '.pm/demo/interpretations/../../other/old.md', '.pm/demo/interpretations/..\\..\\other.md',
    '.pm/demo/%2e%2e/other.md', '.pm/demo//odd.md', '/.pm/demo/absolute.md'];
  const inherited = `${PREFIX}interpretations/retained.md`;
  const stale = `${PREFIX}agent/tasks/obsolete.md`;
  for (const file of [...foreign, inherited, stale]) {
    manifest.files[file] = brand.fileHash('keep');
    f.snapshots.get(BASE).set(file, 'keep');
  }
  f.setManifest(manifest);
  await f.publish();
  const tree = f.calls.find((call) => call.method === 'POST' && call.endpoint.endsWith('/git/trees')).body.tree;
  assert.ok(tree.some((entry) => entry.path === stale && entry.sha === null));
  assert.ok(tree.filter((entry) => entry.sha === null).every((entry) => entry.path.startsWith(PREFIX) && !entry.path.includes('..')));
  for (const file of [...foreign, inherited]) assert.ok(!tree.some((entry) => entry.path === file));
  const next = JSON.parse(f.snapshots.get(NEXT).get(MANIFEST));
  assert.equal(next.files[inherited], manifest.files[inherited]);
  for (const file of foreign) assert.ok(!Object.hasOwn(next.files, file));
});

test('competing ref advance rejects nonforce publish without retry or local success marker', async (t) => {
  const f = fixture(t);
  f.seedLocal();
  const before = f.localText();
  f.hook = (call) => { if (call.method === 'PATCH') f.head = OTHER; };
  await assert.rejects(f.publish(), { code: 'CONFLICT' });
  const patch = f.calls.filter((call) => call.method === 'PATCH');
  assert.equal(patch.length, 1);
  assert.equal(patch[0].body.force, false);
  assert.equal(f.head, OTHER);
  assert.equal(fs.existsSync(f.publishedFile), false);
  unchanged(f, before);
});

test('lost PATCH acknowledgement is reconciled read-only without republishing, even after repeated confirmation failures', async (t) => {
  const f = fixture(t);
  f.seedLocal();
  const before = f.localText();
  f.hook = (call) => {
    if (call.method === 'PATCH') {
      f.head = call.body.sha;
      f.authors = [{ sha: f.head, author: { login: 'Octo' } }];
      throw new Error('fixture PATCH succeeded but response lost');
    }
  };
  const result = await publishPending(f.root, f.project, f.bundle, {
    kind: 'server', signature: 'pinned-before-publish', publish: () => f.publish(),
  });
  assert.equal(result.status, 'error');
  assert.equal(f.head, NEXT);
  const pending = readState(f.root, f.project.id, 'server').pendingPublish;
  assert.equal(pending.attempts, 1);
  assert.equal(knownOwnCommits(readState(f.root, f.project.id, 'server')).size, 0);
  f.calls.length = 0;
  f.hook = (call) => { if (call.endpoint.includes('manifest.json')) throw http(503); };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(reconcilePending(f.root, f.project, {
      kind: 'server', ...pending, confirm: f.api.confirmRemotePublish,
    }));
    const current = readState(f.root, f.project.id, 'server').pendingPublish;
    assert.equal(current.hash, pending.hash);
    assert.equal(current.attemptId, pending.attemptId);
    assert.equal(current.attempts, 1);
  }
  f.hook = null;
  const confirmed = await reconcilePending(f.root, f.project, {
    kind: 'server', ...pending, confirm: f.api.confirmRemotePublish,
  });
  assert.equal(confirmed.commit, NEXT);
  assert.equal(confirmed.parent, BASE);
  const state = readState(f.root, f.project.id, 'server');
  assert.equal(state.pendingPublish, undefined);
  assert.equal(state.publishedHash, f.bundle.hashes.facts);
  assert.equal(state.publishedSignature, 'pinned-before-publish');
  assert.deepEqual([...knownOwnCommits(state)], [NEXT]);
  assert.equal(f.writes().length, 0);
  unchanged(f, before);
});

test('ref transport failure remains the original error and never records success', async (t) => {
  const f = fixture(t);
  const error = http(503);
  f.hook = (call) => { if (call.method === 'PATCH') throw error; };
  await assert.rejects(f.publish(), (err) => err === error);
  assert.equal(f.localWrites.length, 0);
  assert.equal(f.head, BASE);
});

test('sync confirmed manifest 404 is absent and preserves a valid local bundle', async (t) => {
  const f = fixture(t);
  f.seedLocal();
  const before = f.localText();
  assert.equal((await f.sync()).status, 'absent');
  unchanged(f, before);
});

for (const [label, mutate] of [
  ['legacy version', (b) => { b.version = 1; }],
  ['tampered facts', (b) => { b.facts.nodes[0].state = 'ready'; }],
  ['wrong local project', (b) => { b.project.id = 'other'; }],
  ['wrong local repo', (b) => { b.project.repo = 'other/repo'; }],
]) {
  test(`hash-same ${label} local bundle is verified and repaired, never returned same`, async (t) => {
    const f = fixture(t);
    const local = copy(f.bundle);
    mutate(local);
    f.seedLocal(local);
    f.install();
    const result = await f.sync();
    assert.equal(result.status, 'updated');
    assert.equal(result.remoteCommit, BASE);
    assert.deepEqual(JSON.parse(f.localText()), f.bundle);
    assert.equal(f.bundles.verifyBundle(JSON.parse(f.localText())).ok, true);
    assert.equal(f.writes().length, 0);
  });
}

test('hash-same verified local and trusted verified remote returns same with zero writes', async (t) => {
  const f = fixture(t);
  f.seedLocal();
  const before = f.localText();
  f.install();
  assert.equal((await f.sync()).status, 'same');
  assert.ok(f.calls.some((call) => call.endpoint.includes('/commits?')));
  assert.equal(f.calls.filter((call) => call.endpoint.includes('/bundle.parts/')).length, 2);
  assert.equal(f.writes().length, 0);
  unchanged(f, before);
});

for (const [label, mutate] of [
  ['legacy', (b) => { b.version = 1; }], ['unsupported', (b) => { b.version = 999; }],
  ['tampered facts', (b) => { b.facts.nodes[0].state = 'ready'; }],
  ['project id', (b) => { b.project.id = 'other'; }], ['repo', (b) => { b.project.repo = 'other/repo'; }],
]) {
  test(`hash-same invalid remote ${label} cannot bypass validation or overwrite local`, async (t) => {
    const f = fixture(t);
    f.seedLocal();
    const before = f.localText();
    const remote = copy(f.bundle);
    mutate(remote);
    f.install(remote);
    await assert.rejects(f.confirm());
    assert.equal((await f.sync()).status, 'invalid');
    unchanged(f, before);
  });
}

test('valid remote bundle must match the advertised manifest hash before saving', async (t) => {
  const f = fixture(t);
  f.seedLocal();
  const before = f.localText();
  const manifest = f.install(f.makeBundle(true));
  manifest.hash = f.bundle.hashes.facts;
  f.setManifest(manifest);
  await assert.rejects(f.confirm(), { code: 'INVALID_BUNDLE' });
  assert.equal((await f.sync()).status, 'invalid');
  unchanged(f, before);
});

test('bundle validation reports one distinct reason per failure', (t) => {
  const f = fixture(t);
  const cases = [
    ['bundle_format', 'verifyBundle', (b) => { b.version = 999; }, null],
    ['project_id', 'project', (b) => { b.project.id = 'other'; }, null],
    ['repo', 'project', (b) => { b.project.repo = 'other/repo'; }, null],
    ['as_of', 'project', (b) => { b.asOf = 'not-a-date'; }, null],
    ['facts_declared', 'facts', (b) => { b.facts.nodes[0].state = 'ready'; }, null],
    ['facts_recompute', 'facts', (b) => {
      b.plan.nodes[0].title = '哈希后又被改掉的标题';
      b.hashes.facts = canonical.hashOf(b.facts);
    }, null],
    ['manifest', 'manifest', () => {}, (b) => ({ project: 'other', hash: b.hashes.facts })],
  ];
  for (const [reason, stage, mutate, manifestOf] of cases) {
    const bundle = copy(f.bundle);
    mutate(bundle);
    const manifest = manifestOf ? manifestOf(bundle) : null;
    let caught;
    try {
      f.api.validateProjectBundle(f.project, bundle, manifest);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, `${reason} 必须抛错`);
    assert.equal(caught.code, 'INVALID_BUNDLE', reason);
    assert.equal(caught.reason, reason, reason);
    assert.equal(caught.stage, stage, reason);
    assert.match(caught.message, /数据包校验失败/, reason);
    assert.doesNotMatch(caught.message, /"nodes"|"facts"|"evidence"/, '错误信息不得携带包内容');
  }
});

test('sync 的 invalid 结果带上校验原因', async (t) => {
  const f = fixture(t);
  f.seedLocal();
  const before = f.localText();
  const remote = copy(f.bundle);
  remote.facts.nodes[0].state = 'ready';
  f.install(remote);
  const result = await f.sync();
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'facts_declared');
  assert.equal(result.stage, 'facts');
  unchanged(f, before);
});

test('渲染报告后发布收到的内存包仍然有效', async (t) => {
  const f = fixture(t);
  const bundle = copy(f.bundle);
  const report = render.renderAudit(bundle.facts, bundle.project, bundle.project.planSource);
  assert.match(report, /进度审计/);
  assert.equal(f.bundles.verifyBundle(bundle).ok, true);
  const result = await f.publish(bundle);
  assert.equal(result.status, 'published');
  assert.equal(f.bundles.verifyBundle(bundle).ok, true);
  assert.ok(f.calls.some((call) => call.method === 'POST' && call.endpoint.endsWith('/git/commits')));
});

for (const [label, authors] of [
  ['unapproved author', [{ sha: AUTHOR_COMMIT, author: { login: 'outsider' } }]],
  ['missing login', [{ sha: AUTHOR_COMMIT, author: null }]],
  ['missing history', []], ['missing commit SHA', [{ author: { login: 'Octo' } }]],
  ['empty login', [{ sha: AUTHOR_COMMIT, author: { login: ' ' } }]],
]) {
  test(`hash-same sync ${label} is untrusted and preserves local`, async (t) => {
    const f = fixture(t);
    f.seedLocal();
    const before = f.localText();
    f.install();
    f.authors = authors;
    assert.equal((await f.sync()).status, 'untrusted');
    unchanged(f, before);
  });
}

test('sync with no configured trust anchor does not accept remote author assertions', async (t) => {
  const f = fixture(t, { noAdmins: true });
  f.install();
  assert.equal((await f.sync()).status, 'untrusted');
  assert.equal(f.localWrites.length, 0);
});

for (const stage of ['manifest.json', '/bundle.parts/', '/commits?']) {
  for (const status of [403, 429, 503]) {
    test(`sync ${stage} HTTP ${status} propagates and preserves local`, async (t) => {
      const f = fixture(t);
      f.seedLocal();
      const before = f.localText();
      f.install();
      const error = http(status);
      f.hook = (call) => { if (call.endpoint.includes(stage)) throw error; };
      await assert.rejects(f.sync(), (err) => err === error);
      unchanged(f, before);
    });
  }
}

for (const kind of ['missing part', 'compressed hash', 'gzip', 'JSON', 'missing bundle', 'base64']) {
  test(`sync malformed/missing remote ${kind} is invalid, not absent, even with a matching local hash`, async (t) => {
    const f = fixture(t);
    f.seedLocal();
    const before = f.localText();
    const manifest = f.install(f.bundle, kind === 'JSON' || kind === 'missing bundle' ? 'json' : 'parts');
    const files = f.snapshots.get(BASE);
    if (kind === 'missing part') files.delete(`${PREFIX}bundle.parts/01.b64`);
    if (kind === 'compressed hash') { manifest.bundle.sha256 = '0'.repeat(64); f.setManifest(manifest); }
    if (kind === 'gzip' || kind === 'base64') {
      delete manifest.bundle.sha256;
      manifest.bundle.parts = ['bundle.parts/00.b64'];
      f.setManifest(manifest);
      files.set(`${PREFIX}bundle.parts/00.b64`, kind === 'gzip' ? Buffer.from('not gzip').toString('base64') : '!');
    }
    if (kind === 'JSON') files.set(`${PREFIX}bundle.pm.json`, '{invalid');
    if (kind === 'missing bundle') files.delete(`${PREFIX}bundle.pm.json`);
    await assert.rejects(f.confirm(), { code: 'INVALID_REMOTE_DATA' });
    assert.equal((await f.sync()).status, 'invalid');
    unchanged(f, before);
  });
}

for (const layout of ['parts', 'gzip', 'json']) {
  test(`sync pins manifest, trust query and ${layout} reads to one snapshot despite branch movement`, async (t) => {
    const f = fixture(t);
    f.install(f.bundle, layout);
    f.snapshots.set(OTHER, new Map());
    f.hook = (call) => { if (call.endpoint.includes('manifest.json')) f.head = OTHER; };
    const result = await f.sync();
    assert.equal(result.status, 'updated');
    assert.equal(result.remoteCommit, BASE);
    assert.deepEqual(JSON.parse(f.localText()), f.bundle);
    for (const call of f.calls) {
      const url = new URL(`https://fixture.invalid/${call.endpoint}`);
      if (url.pathname.includes('/contents/')) assert.equal(url.searchParams.get('ref'), BASE);
      if (url.pathname.endsWith('/commits')) assert.equal(url.searchParams.get('sha'), BASE);
    }
    assert.equal(f.calls.filter((call) => call.endpoint.includes('git/ref/heads/')).length, 1);
    assert.equal(f.writes().length, 0);
  });
}

test('contents blob fallback uses immutable content SHA; parts honor the supplied snapshot ref', async (t) => {
  const f = fixture(t);
  f.install();
  const blobSha = '1'.repeat(40);
  const partPath = `${PREFIX}bundle.parts/00.b64`;
  f.blobs.set(blobSha, f.snapshots.get(BASE).get(partPath));
  f.hook = (call) => call.endpoint.includes(`/contents/${partPath}?`) ? { sha: blobSha, encoding: 'none', content: '' } : undefined;
  assert.equal((await f.sync()).status, 'updated');
  assert.ok(f.calls.some((call) => call.endpoint.endsWith(`/git/blobs/${blobSha}`)));
  assert.ok(f.calls.find((call) => call.endpoint.includes(partPath)).endpoint.endsWith(`?ref=${BASE}`));
});

for (const status of [404, 503]) {
  test(`manifest referenced blob HTTP ${status} never becomes absence or permits publication`, async (t) => {
    const f = fixture(t);
    const error = http(status);
    f.hook = (call) => {
      if (call.endpoint.includes('/contents/')) return { sha: '1'.repeat(40), encoding: 'none' };
      if (call.endpoint.includes('/git/blobs/')) throw error;
    };
    await assert.rejects(f.publish(), (err) => status === 404 ? err.code === 'INVALID_REMOTE_DATA' : err === error);
    assert.equal(f.writes().length, 0);
    assert.equal(f.localWrites.length, 0);
  });
}

// Real lock module + atomic write: these prove sync/adopt are serialized and
// that a failed replacement cannot destroy the previous bundle.
function holdLock(f, token = 'fixture-holder') {
  fs.mkdirSync(path.dirname(f.lockFile), { recursive: true });
  fs.writeFileSync(f.lockFile, `${JSON.stringify({ pid: process.pid, token, acquiredAt: Date.now() })}\n`);
  return fs.readFileSync(f.lockFile, 'utf8');
}

test('sync 遇到活进程持锁时 BUSY，不写本地且不改动现役锁', async (t) => {
  const f = fixture(t);
  f.seedLocal(f.makeBundle(true));
  const before = f.localText();
  f.install();
  const held = holdLock(f);
  await assert.rejects(f.sync(), { code: 'BUSY' });
  assert.equal(fs.readFileSync(f.lockFile, 'utf8'), held, '竞争者不得移动或改写现役锁');
  unchanged(f, before);
});

test('adopt 遇到活进程持锁时在读取远端前 BUSY，不建项目', async (t) => {
  const f = fixture(t);
  const held = holdLock(f);
  await assert.rejects(
    f.api.adoptFromRemote(f.root, { repo: f.project.repo, id: f.project.id, branch: 'release/test' }),
    { code: 'BUSY' },
  );
  assert.equal(f.calls.length, 0, '持锁冲突不得触发任何 GitHub 请求');
  assert.equal(fs.readFileSync(f.lockFile, 'utf8'), held);
  assert.equal(fs.existsSync(path.join(f.root, 'data', f.project.id, 'bundle.pm.json')), false);
});

test('sync 原子替换审计包时持有真实项目锁，结束后释放', async (t) => {
  const f = fixture(t);
  f.seedLocal(f.makeBundle(true));
  f.install();
  let observed = null;
  f.hooks.rename = (from, to) => {
    if (path.basename(to) === 'bundle.pm.json') observed = JSON.parse(fs.readFileSync(f.lockFile, 'utf8'));
  };
  const result = await f.sync();
  assert.equal(result.status, 'updated');
  assert.ok(observed, '写入审计包时必须已持有项目锁');
  assert.equal(observed.pid, process.pid);
  assert.equal(typeof observed.token, 'string');
  assert.equal(observed.token.length, 36);
  assert.equal(fs.existsSync(f.lockFile), false, '操作结束后必须释放项目锁');
  assert.deepEqual(JSON.parse(f.localText()), f.bundle);
});

test('原子替换中途失败保留旧包字节，不残留临时文件并释放锁', async (t) => {
  const f = fixture(t);
  f.seedLocal(f.makeBundle(true));
  const before = f.localText();
  f.install();
  f.hooks.failRename = (to) => path.basename(to) === 'bundle.pm.json';
  await assert.rejects(f.sync(), (err) => err.code === 'EIO');
  unchanged(f, before);
  const leftovers = fs.readdirSync(path.dirname(f.bundleFile)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '失败后不得残留临时文件');
  assert.equal(fs.existsSync(f.lockFile), false);
});

