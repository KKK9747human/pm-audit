import test from 'node:test';
import assert from 'node:assert/strict';
import { probeRemote, classifyProbe, signatureOf } from '../src/watch.mjs';

const HEAD = 'b'.repeat(40);
const TOPIC = 'a'.repeat(40);
const MERGE = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const TIME = '2026-11-20T10:00:00Z';
const LATER = '2026-11-20T11:00:00Z';
const PROJECT = { id: 'arbitrarynotDACE', repo: 'fixture/never-contact', defaultBranch: 'release/slash' };
const KINDS = ['pulls', 'issues'];
const fieldOf = (kind) => kind === 'pulls' ? 'openPrs' : 'openIssues';
const issue = (number = 1, over = {}) => ({
  number, title: `Issue #${number}`, body: 'pm:node=A1', state: 'OPEN',
  updated_at: TIME, closed_at: null, ...over,
});
const pull = (number = 1, over = {}) => ({
  ...issue(number), title: `PR #${number}`, merged_at: null, mergeCommit: null,
  headRefOid: TOPIC, headRefName: 'feature/deleted', baseRefOid: HEAD, baseRefName: 'release/slash',
  ...over,
});
const makeNode = (kind, number, over) => (kind === 'pulls' ? pull : issue)(number, over);
const rows = (kind, count) => Array.from({ length: count }, (_, i) => makeNode(kind, i + 1));
const snapshot = (project = PROJECT, over = {}) => ({
  pushedAt: TIME, defaultBranch: project.defaultBranch, repositoryDefaultBranch: 'main',
  headSha: HEAD, branches: [{ name: project.defaultBranch, sha: HEAD }],
  openPrs: [], openIssues: [], snapshotComplete: true, ...over,
});
const classify = (nextProbe, prevProbe = snapshot()) => classifyProbe({
  prevProbe, nextProbe, projectId: PROJECT.id, knownOwn: new Set(),
});
const assertUnknown = (next, previous = snapshot()) => {
  assert.equal(next.snapshotComplete, false);
  for (const prev of [previous, next, { ...next, snapshotComplete: true }]) {
    const decision = classify(next, prev);
    assert.equal(decision.unknown, true, 'incomplete evidence must not become no-change');
    assert.equal(decision.changed, false);
    assert.equal(decision.ownOnly, false);
  }
};
const assertChanged = (next, previous) => {
  assert.equal(next.snapshotComplete, true);
  assert.notEqual(signatureOf(next), signatureOf(previous));
  const decision = classify(next, previous);
  assert.equal(decision.changed, true);
  assert.equal(decision.unknown, false);
  assert.equal(decision.ownOnly, false);
};

// Cursors are deliberately opaque, including quotes: only variables may carry them.
const cursor = (kind, offset) => `${kind}:cursor:"${offset}"/opaque==`;

function queryKind(query) {
  assert.equal(typeof query, 'string');
  const connections = [...query.matchAll(/\bentries\s*:\s*(pullRequests|issues)\s*\(/g)];
  assert.equal(connections.length, 1, 'one separate, entries-aliased connection per query');
  return connections[0][1] === 'pullRequests' ? 'pulls' : 'issues';
}

function assertQuery(query, kind, project) {
  assert.match(query, /^\s*query\b/);
  assert.doesNotMatch(query, /\bmutation\b/i);
  for (const variable of ['owner', 'name']) {
    assert.match(query, new RegExp(`\\$${variable}\\s*:\\s*String\\s*!`));
    assert.match(query, new RegExp(`\\b${variable}\\s*:\\s*\\$${variable}\\b`));
  }
  assert.match(query, /\$after\s*:\s*String\b/);
  const connection = kind === 'pulls' ? 'pullRequests' : 'issues';
  const args = query.match(new RegExp(`\\bentries\\s*:\\s*${connection}\\s*\\(([\\s\\S]*?)\\)`))?.[1];
  assert.ok(args, 'connection arguments are present');
  assert.match(args, /\bfirst\s*:\s*50\b/);
  assert.match(args, /\bafter\s*:\s*\$after\b/);
  const states = args.match(/\bstates\s*:\s*\[([^\]]*)\]/)?.[1];
  assert.ok(states);
  assert.deepEqual(states.trim().split(/[\s,]+/).sort(),
    (kind === 'pulls' ? ['OPEN', 'CLOSED', 'MERGED'] : ['OPEN', 'CLOSED']).sort());
  const order = args.match(/\borderBy\s*:\s*\{([^}]*)\}/)?.[1];
  assert.ok(order);
  assert.match(order, /\bfield\s*:\s*CREATED_AT\b/);
  assert.match(order, /\bdirection\s*:\s*ASC\b/);
  assert.match(query, /\bupdated_at\s*:\s*updatedAt\b/);
  assert.match(query, /\bclosed_at\s*:\s*closedAt\b/);
  if (kind === 'pulls') {
    assert.match(query, /\bmerged_at\s*:\s*mergedAt\b/);
    assert.match(query, /\bmergeCommit\s*\{\s*oid\s*\}/);
  }
  // A selection whitelist catches newly introduced payload-heavy fields.
  const required = [
    'repository', 'nameWithOwner', 'entries', connection, 'totalCount', 'nodes',
    'pageInfo', 'hasNextPage', 'endCursor', 'number', 'title', 'body', 'state',
    'updated_at', 'updatedAt', 'closed_at', 'closedAt',
    ...(kind === 'pulls' ? ['merged_at', 'mergedAt', 'mergeCommit', 'oid',
      'headRefOid', 'headRefName', 'baseRefOid', 'baseRefName'] : []),
  ];
  const selected = query.slice(query.indexOf('{')).replace(/\([^)]*\)/g, '').match(/[A-Za-z_][A-Za-z_0-9]*/g) || [];
  for (const name of required) assert.ok(selected.includes(name), `missing selection: ${name}`);
  for (const name of selected) assert.ok(required.includes(name) || name === '__typename', `unwanted selection: ${name}`);
  for (const value of [project.repo, ...project.repo.split('/'), project.defaultBranch]) {
    assert.ok(!query.includes(JSON.stringify(value)), 'repository/branch values must not be embedded as literals');
  }
}

function fixture({ project = PROJECT, pulls = [], issues = [], respond, branches } = {}) {
  const calls = [];
  const graphql = [];
  const denied = [];
  const queries = new Map();
  let sharedSignal;
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    assert.ok(calls.length <= 46, 'bounded fixture: no unbounded pagination or retries');
    assert.equal(options.retries, 1);
    assert.ok(Number.isFinite(options.timeout) && options.timeout > 0 && options.timeout <= 30000);
    assert.ok(options.signal instanceof AbortSignal);
    options.signal.throwIfAborted();
    sharedSignal ??= options.signal;
    assert.equal(options.signal, sharedSignal, 'all requests share the probe cancellation signal');
    if (url === `repos/${project.repo}`) {
      assert.equal(options.method ?? 'GET', 'GET');
      return { pushed_at: TIME, default_branch: 'main' };
    }
    const prefix = `repos/${project.repo}/branches?`;
    if (url.startsWith(prefix)) {
      const params = new URLSearchParams(url.slice(prefix.length));
      assert.equal(params.get('per_page'), '100');
      assert.equal(params.get('page'), '1');
      assert.equal(options.method ?? 'GET', 'GET');
      return branches ? branches(options) : [{ name: project.defaultBranch, commit: { sha: HEAD } }];
    }
    if (url !== 'graphql') {
      denied.push(url);
      assert.fail(`forbidden REST item/history request (no network fallback): ${url}`);
    }
    assert.equal(options.method, 'POST');
    assert.deepEqual(Object.keys(options.body).sort(), ['query', 'variables']);
    const { query, variables } = options.body;
    const kind = queryKind(query);
    assertQuery(query, kind, project);
    const [owner, name] = project.repo.split('/');
    assert.deepEqual(Object.keys(variables).sort(), ['after', 'name', 'owner']);
    assert.equal(variables.owner, owner);
    assert.equal(variables.name, name);
    assert.ok(variables.after === null || typeof variables.after === 'string');
    if (queries.has(kind)) assert.equal(query, queries.get(kind), 'cursor pages reuse query text, not cached response');
    queries.set(kind, query);
    const source = kind === 'pulls' ? pulls : issues;
    let offset = 0;
    if (variables.after !== null) {
      offset = Array.from({ length: 20 }, (_, i) => (i + 1) * 50)
        .find((n) => cursor(kind, n) === variables.after);
      assert.ok(offset, `unexpected ${kind} cursor: ${variables.after}`);
    }
    const nodes = structuredClone(source.slice(offset, offset + 50));
    const end = offset + nodes.length;
    const result = { data: { repository: { nameWithOwner: project.repo, entries: {
      totalCount: source.length, nodes,
      pageInfo: { hasNextPage: end < source.length, endCursor: nodes.length ? cursor(kind, end) : null },
    } } } };
    const call = { kind, offset, query, variables: { ...variables }, options };
    graphql.push(call);
    return respond ? respond({ ...call, result, entries: result.data.repository.entries }) : result;
  };
  return {
    calls, graphql, denied,
    run: async (options = {}) => {
      const next = await probeRemote(project, {
        prevProbe: snapshot(project), now: () => 0, sleep: async () => {}, ...options, request,
      });
      assert.deepEqual(denied, [], 'errors must never trigger REST fallback');
      assert.equal(calls.some(({ url }) => /\/(?:compare|commits|git)\b/.test(url)), false);
      return next;
    },
  };
}

test('separate read queries use variables, lean selections, all states and REST meta/branches only', { timeout: 3000 }, async () => {
  const project = { ...PROJECT, repo: 'arbitrarynotDACE/quoted-repo.name_2' };
  const f = fixture({ project });
  const next = await f.run();
  assert.equal(next.snapshotComplete, true);
  assert.equal(next.headSha, HEAD);
  assert.equal(next.defaultBranch, 'release/slash');
  assert.equal(next.repositoryDefaultBranch, 'main');
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.graphql.map((c) => c.kind).sort(), KINDS.slice().sort());
  assert.ok(f.graphql.every((c) => c.variables.after === null));
  assert.equal(classify(next, snapshot(project)).unknown, false);
  assert.equal(classify(next, snapshot(project)).changed, false);
});

for (const kind of KINDS) {
  for (const count of [0, 50, 51, 201, 1000, 1001]) {
    test(`${kind}: pagination of ${count} items respects explicit totals and the 1000-item cap`, { timeout: 3000 }, async () => {
      const f = fixture({ [kind]: rows(kind, count) });
      const next = await f.run();
      const pages = f.graphql.filter((c) => c.kind === kind);
      assert.ok(pages.length >= 1 && pages.length <= 20);
      assert.ok(next[fieldOf(kind)].length <= 1000);
      assert.equal(f.graphql.filter((c) => c.kind !== kind).length, 1);
      if (count > 1000) {
        assertUnknown(next);
      } else {
        assert.equal(next.snapshotComplete, true);
        assert.equal(next[fieldOf(kind)].length, count);
        assert.equal(pages.length, Math.max(1, Math.ceil(count / 50)), 'no speculative empty page after an exact full final page');
        assert.deepEqual(next[fieldOf(kind)].map((s) => JSON.parse(s)[0]).sort((a, b) => a - b),
          Array.from({ length: count }, (_, i) => i + 1));
        assert.equal(classify(next, next).unknown, false);
        assert.equal(classify(next, next).changed, false);
      }
      assert.equal(new Set(pages.map((c) => c.variables.after)).size, pages.length);
      assert.deepEqual(pages.map((c) => c.variables.after),
        pages.map((_, i) => i === 0 ? null : cursor(kind, i * 50)));
    });
  }
}

test('cache distinguishes both POST bodies and each cursor page at the same graphql endpoint', { timeout: 3000 }, async () => {
  const f = fixture({ pulls: rows('pulls', 51), issues: rows('issues', 201) });
  const next = await f.run();
  assert.equal(next.snapshotComplete, true);
  assert.equal(next.openPrs.length, 51);
  assert.equal(next.openIssues.length, 201);
  assert.equal(f.graphql.length, 7);
  assert.equal(new Set(f.graphql.map((c) => JSON.stringify(c.options.body))).size, 7);
  assert.equal(JSON.parse(next.openPrs.at(-1))[2], 'PR #51');
  assert.equal(JSON.parse(next.openIssues.at(-1))[2], 'Issue #201');
});

test('GraphQL nodes produce exactly the manually expected REST-shaped canonical evidence', { timeout: 3000 }, async () => {
  const title = 'A "quoted" title';
  const body = 'pm:node=A1\nbackslash \\ and 中文';
  const f = fixture({
    pulls: [
      pull(1, { title, body, mergeCommit: { oid: OTHER } }),
      pull(2, { state: 'CLOSED', body: '', closed_at: TIME }),
      pull(3, { state: 'MERGED', closed_at: TIME, merged_at: TIME, mergeCommit: { oid: MERGE } }),
    ],
    issues: [issue(4, { body: '' }), issue(5, { state: 'CLOSED', closed_at: TIME, title, body })],
  });
  const expectedPrs = [
    JSON.stringify([1, 'open', title, body, TIME, null, null, null, TOPIC, 'feature/deleted', 'release/slash']),
    JSON.stringify([2, 'closed', 'PR #2', null, TIME, TIME, null, null, TOPIC, 'feature/deleted', 'release/slash']),
    JSON.stringify([3, 'closed', 'PR #3', 'pm:node=A1', TIME, TIME, TIME, MERGE, TOPIC, 'feature/deleted', 'release/slash']),
  ];
  const expectedIssues = [
    JSON.stringify([4, 'open', 'Issue #4', null, TIME, null]),
    JSON.stringify([5, 'closed', title, body, TIME, TIME]),
  ];
  const next = await f.run();
  const rest = snapshot(PROJECT, { openPrs: expectedPrs, openIssues: expectedIssues });
  assert.equal(next.snapshotComplete, true);
  assert.deepEqual(next.openPrs.slice().sort(), expectedPrs.slice().sort());
  assert.deepEqual(next.openIssues.slice().sort(), expectedIssues.slice().sort());
  assert.equal(signatureOf(next), signatureOf(rest));
  assert.equal(classify(next, rest).changed, false);
  assert.equal(classify(next, rest).unknown, false);
  assert.equal(classify(next, null).changed, true, 'a complete initial snapshot is usable');
});

test('record, page and object-key order do not alter signatures', { timeout: 3000 }, async () => {
  const pulls = rows('pulls', 51);
  const issues = rows('issues', 51);
  const before = await fixture({ pulls, issues }).run();
  const reorder = (items) => items.slice().reverse().map((item) => Object.fromEntries(Object.entries(item).reverse()));
  const next = await fixture({ pulls: reorder(pulls), issues: reorder(issues) }).run({ prevProbe: before });
  assert.equal(next.snapshotComplete, true);
  assert.equal(signatureOf(next), signatureOf(before));
  assert.equal(classify(next, before).changed, false);
  assert.equal(classify(next, before).unknown, false);
});

for (const kind of KINDS) {
  test(`${kind}: absent descriptions normalize without erasing whitespace or content changes`, { timeout: 3000 }, async () => {
    const empty = await fixture({ [kind]: [makeNode(kind, 1, { body: '' })] }).run();
    const missing = await fixture({ [kind]: [makeNode(kind, 1, { body: null })] }).run();
    assert.equal(empty.snapshotComplete, true);
    assert.equal(JSON.parse(empty[fieldOf(kind)][0])[3], null);
    assert.equal(signatureOf(empty), signatureOf(missing));
    assert.equal(classify(empty, missing).changed, false);
    for (const body of [' ', '\n', 'pm:node=B2']) {
      const edited = await fixture({ [kind]: [makeNode(kind, 1, { body })] }).run();
      assertChanged(edited, empty);
      assertChanged(empty, edited);
      assert.equal(JSON.parse(edited[fieldOf(kind)][0])[3], body);
    }
  });
  test(`${kind}: closed record #201 body edit is visible with unchanged timestamps and head`, { timeout: 3000 }, async () => {
    const items = rows(kind, 201).map((node) => ({ ...node, state: 'CLOSED', closed_at: TIME }));
    const before = await fixture({ [kind]: items }).run();
    items[200] = { ...items[200], body: 'pm:node=B2' };
    const next = await fixture({ [kind]: items }).run({ prevProbe: before });
    assertChanged(next, before);
  });
  for (const [label, patch] of [
    ['number', { number: 42 }], ['title', { title: 'Edited title' }], ['body', { body: null }],
    ['state', { state: 'OPEN', closed_at: null }], ['updated time', { updated_at: LATER }],
    ['closed time', { closed_at: LATER }],
    ...(kind === 'pulls' ? [
      ['merged time', { state: 'MERGED', merged_at: TIME, mergeCommit: { oid: MERGE } }],
      ['closed merge SHA', { mergeCommit: { oid: MERGE } }],
      ['deleted branch head OID', { headRefOid: OTHER }],
      ['head ref', { headRefName: 'feature/renamed' }], ['base ref', { baseRefName: 'release/other' }],
    ] : []),
  ]) {
    test(`${kind}: canonical signature preserves changed ${label}`, { timeout: 3000 }, async () => {
      const node = makeNode(kind, 1, { state: 'CLOSED', closed_at: TIME });
      const before = await fixture({ [kind]: [node] }).run();
      const next = await fixture({ [kind]: [{ ...node, ...patch }] }).run({ prevProbe: before });
      assertChanged(next, before);
    });
  }
  for (const initial of ['absent', 'open']) {
    test(`${kind}: ${initial} to closed between probes is a real change`, { timeout: 3000 }, async () => {
      const before = await fixture({ [kind]: initial === 'open' ? [makeNode(kind, 1)] : [] }).run();
      const next = await fixture({ [kind]: [makeNode(kind, 1, { state: 'CLOSED', closed_at: TIME })] })
        .run({ prevProbe: before });
      assertChanged(next, before);
    });
  }
}

test('merged PR merge OID changes remain evidence even with a deleted source branch', { timeout: 3000 }, async () => {
  const node = pull(1, { state: 'MERGED', closed_at: TIME, merged_at: TIME, mergeCommit: { oid: MERGE } });
  // No live headRef object or branch entry exists; headRefOid is the durable proof.
  const before = await fixture({ pulls: [node] }).run();
  const next = await fixture({ pulls: [{ ...node, mergeCommit: { oid: OTHER } }] }).run({ prevProbe: before });
  assertChanged(next, before);
  assert.equal(JSON.parse(next.openPrs[0])[8], TOPIC);
});

for (const state of ['OPEN', 'CLOSED', 'MERGED']) {
  test(`PR ${state}: base OID remains validation-only, not fingerprint evidence`, { timeout: 3000 }, async () => {
    const node = pull(1, state === 'OPEN' ? {} : {
      state, closed_at: TIME, merged_at: state === 'MERGED' ? TIME : null,
      mergeCommit: state === 'MERGED' ? { oid: MERGE } : null,
    });
    const before = await fixture({ pulls: [node] }).run();
    const next = await fixture({ pulls: [{ ...node, baseRefOid: OTHER,
      ...(state === 'OPEN' ? { mergeCommit: { oid: OTHER } } : {}),
    }] }).run({ prevProbe: before });
    assert.equal(next.snapshotComplete, true);
    assert.equal(signatureOf(next), signatureOf(before));
    assert.equal(classify(next, before).changed, false);
    assert.equal(classify(next, before).unknown, false);
  });
}

test('case-insensitive repository identity and an empty errors array are accepted', { timeout: 3000 }, async () => {
  const next = await fixture({ pulls: [pull()], issues: [issue(2)], respond: ({ result }) => {
    result.data.repository.nameWithOwner = 'FIXTURE/NEVER-CONTACT';
    result.errors = [];
    return result;
  } }).run();
  assert.equal(next.snapshotComplete, true);
});

const malformed = [
  { label: 'null response', mutate: () => null },
  { label: 'missing data', mutate: () => ({}) },
  { label: 'null data', mutate: () => ({ data: null }) },
  { label: 'missing repository', mutate: () => ({ data: {} }) },
  { label: 'null repository', mutate: () => ({ data: { repository: null } }) },
  { label: 'missing repository identity', edit: ({ result }) => { delete result.data.repository.nameWithOwner; } },
  { label: 'wrong repository identity', edit: ({ result }) => { result.data.repository.nameWithOwner = 'fixture/somewhere-else'; } },
  { label: 'non-string repository identity', edit: ({ result }) => { result.data.repository.nameWithOwner = 7; } },
  { label: 'missing connection', edit: ({ result }) => { delete result.data.repository.entries; } },
  { label: 'null connection', edit: ({ result }) => { result.data.repository.entries = null; } },
  { label: 'missing totalCount', edit: ({ entries }) => { delete entries.totalCount; } },
  ...[null, -1, 1.5, '1'].map((value) => ({ label: `invalid totalCount ${JSON.stringify(value)}`, edit: ({ entries }) => { entries.totalCount = value; } })),
  { label: 'total smaller than returned rows', edit: ({ entries }) => { entries.totalCount = 0; } },
  { label: 'missing rows despite a larger total', edit: ({ entries }) => { entries.totalCount = 2; } },
  { label: 'empty rows despite positive total', edit: ({ entries }) => { entries.nodes = []; } },
  { label: 'absent nodes', edit: ({ entries }) => { delete entries.nodes; } },
  { label: 'null nodes', edit: ({ entries }) => { entries.nodes = null; } },
  { label: 'non-array nodes', edit: ({ entries }) => { entries.nodes = {}; } },
  { label: 'null node', edit: ({ entries }) => { entries.nodes[0] = null; } },
  { label: 'duplicate numbers within a page', count: 2, edit: ({ entries }) => { entries.nodes[1].number = entries.nodes[0].number; } },
  { label: 'missing pageInfo', edit: ({ entries }) => { delete entries.pageInfo; } },
  ...[null, [], 'bad'].map((value) => ({ label: `invalid pageInfo ${JSON.stringify(value)}`, edit: ({ entries }) => { entries.pageInfo = value; } })),
  { label: 'missing hasNextPage', edit: ({ entries }) => { delete entries.pageInfo.hasNextPage; } },
  ...[null, 0, 'false'].map((value) => ({ label: `invalid hasNextPage ${JSON.stringify(value)}`, edit: ({ entries }) => { entries.pageInfo.hasNextPage = value; } })),
  { label: 'missing endCursor', edit: ({ entries }) => { delete entries.pageInfo.endCursor; } },
  ...[3, {}, []].map((value) => ({ label: `invalid endCursor ${JSON.stringify(value)}`, edit: ({ entries }) => { entries.pageInfo.endCursor = value; } })),
  ...[null, ''].map((value) => ({ label: `continuation cursor ${JSON.stringify(value)}`, count: 51,
    edit: ({ entries }) => { entries.pageInfo.endCursor = value; } })),
  { label: 'continuation claimed after total reached', edit: ({ entries }) => { entries.pageInfo.hasNextPage = true; } },
  { label: 'terminal page before total reached', count: 51, edit: ({ entries }) => { entries.pageInfo.hasNextPage = false; } },
  { label: 'overfull 51-row page', count: 51, edit: ({ kind, entries }) => { entries.nodes.push(makeNode(kind, 51)); } },
  { label: 'nonempty GraphQL errors with otherwise complete data', edit: ({ result }) => { result.errors = [{ message: 'field resolver failed', path: ['repository', 'entries'] }]; } },
  { label: 'GraphQL errors and partial data', edit: ({ result, entries }) => { result.errors = [{ message: 'partial' }]; entries.nodes[0] = null; } },
  ...[null, {}, 'failure', 1, [null], [{}]].map((value) => ({ label: `malformed errors ${JSON.stringify(value)}`, edit: ({ result }) => { result.errors = value; } })),
  { label: 'totalCount changes on page two', count: 51, maxPages: 2,
    edit: ({ offset, entries }) => { if (offset) entries.totalCount = 52; } },
  { label: 'totalCount disappears on page two', count: 51, maxPages: 2,
    edit: ({ offset, entries }) => { if (offset) delete entries.totalCount; } },
  { label: 'duplicate number across pages', count: 51, maxPages: 2,
    edit: ({ offset, entries }) => { if (offset) entries.nodes[0].number = 1; } },
  { label: 'missing final row', count: 51, maxPages: 2,
    edit: ({ offset, entries }) => { if (offset) entries.nodes = []; } },
  { label: 'short intermediate page loses a row', count: 101, maxPages: 3,
    edit: ({ offset, entries }) => { if (!offset) entries.nodes.pop(); } },
  { label: 'cursor repeats immediately', count: 151, maxPages: 2,
    edit: ({ offset, entries, variables }) => { if (offset) entries.pageInfo.endCursor = variables.after; } },
  { label: 'cursor cycles back to an earlier page', count: 151, maxPages: 3,
    edit: ({ kind, offset, entries }) => { if (offset === 100) entries.pageInfo.endCursor = cursor(kind, 50); } },
  { label: 'repository identity changes on a later page', count: 51, maxPages: 2,
    edit: ({ offset, result }) => { if (offset) result.data.repository.nameWithOwner = 'other/repository'; } },
  { label: 'pageInfo missing on a later page', count: 51, maxPages: 2,
    edit: ({ offset, entries }) => { if (offset) delete entries.pageInfo; } },
  { label: 'GraphQL error on a later page', count: 51, maxPages: 2,
    edit: ({ offset, result }) => { if (offset) result.errors = [{ message: 'page failed' }]; } },
  { label: 'missing required field on a later page', count: 51, maxPages: 2,
    edit: ({ offset, entries }) => { if (offset) delete entries.nodes[0].body; } },
  { label: '1000 rows but total claims 999', count: 1000, maxPages: 20,
    edit: ({ entries }) => { entries.totalCount = 999; } },
  { label: '1000 rows but terminal page claims continuation', count: 1000, maxPages: 20,
    edit: ({ offset, entries }) => { if (offset === 950) entries.pageInfo.hasNextPage = true; } },
];

for (const kind of KINDS) {
  for (const scenario of malformed) {
    test(`${kind}: ${scenario.label} is unknown without REST fallback`, { timeout: 3000 }, async () => {
      const f = fixture({
        [kind]: rows(kind, scenario.count ?? 1),
        respond: (context) => {
          if (context.kind !== kind) return context.result;
          if (scenario.mutate) return scenario.mutate(context);
          scenario.edit(context);
          return context.result;
        },
      });
      const next = await f.run();
      assertUnknown(next);
      const pages = f.graphql.filter((c) => c.kind === kind);
      assert.ok(pages.length >= 1 && pages.length <= (scenario.maxPages ?? 2));
    });
  }
}

const commonFields = ['number', 'title', 'body', 'state', 'updated_at', 'closed_at'];
const prFields = ['merged_at', 'mergeCommit', 'headRefOid', 'headRefName', 'baseRefOid', 'baseRefName'];
const invalidCommon = [
  ['zero number', { number: 0 }], ['negative number', { number: -1 }],
  ['fractional number', { number: 1.5 }], ['string number', { number: '1' }],
  ['null title', { title: null }], ['non-string body', { body: 42 }],
  ['unknown state', { state: 'UNKNOWN' }], ['null state', { state: null }],
  ['empty update time', { updated_at: '' }], ['null update time', { updated_at: null }],
  ['non-string update time', { updated_at: 1 }], ['empty closed time', { closed_at: '' }],
  ['non-string closed time', { closed_at: 1 }],
];
const invalidPr = [
  ['empty merged time', { merged_at: '' }], ['non-string merged time', { merged_at: 1 }],
  ['missing merge OID', { mergeCommit: {} }], ['null merge OID', { mergeCommit: { oid: null } }],
  ['short merge OID', { mergeCommit: { oid: 'abc' } }], ['non-hex merge OID', { mergeCommit: { oid: 'z'.repeat(40) } }],
  ['short head OID', { headRefOid: 'abc' }], ['null head OID', { headRefOid: null }],
  ['invalid head OID', { headRefOid: 'z'.repeat(40) }], ['empty head ref', { headRefName: '' }],
  ['null head ref', { headRefName: null }], ['short base OID', { baseRefOid: 'abc' }],
  ['null base OID', { baseRefOid: null }], ['invalid base OID', { baseRefOid: 'z'.repeat(40) }],
  ['empty base ref', { baseRefName: '' }], ['null base ref', { baseRefName: null }],
];
for (const kind of KINDS) {
  for (const field of [...commonFields, ...(kind === 'pulls' ? prFields : [])]) {
    test(`${kind}: missing node field ${field} is incomplete`, { timeout: 3000 }, async () => {
      const node = makeNode(kind, 1);
      delete node[field];
      const next = await fixture({ [kind]: [node] }).run();
      assertUnknown(next);
    });
  }
  for (const [label, patch] of [...invalidCommon, ...(kind === 'pulls' ? invalidPr : [['MERGED issue', { state: 'MERGED' }]])]) {
    test(`${kind}: ${label} is incomplete`, { timeout: 3000 }, async () => {
      const next = await fixture({ [kind]: [makeNode(kind, 1, patch)] }).run();
      assertUnknown(next);
    });
  }
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
function hangingFixture(failKind) {
  const ready = deferred();
  const active = new Set();
  const aborted = [];
  const failure = new Error(`synthetic ${failKind} transport rejection`);
  let failures = 0;
  const wait = (label, { signal }) => {
    signal.throwIfAborted();
    active.add(label);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted.push(label);
        setImmediate(() => {
          active.delete(label);
          reject(signal.reason);
        });
      }, { once: true });
      if (active.size === (failKind ? 2 : 3)) ready.resolve();
    });
  };
  const f = fixture({
    branches: (options) => wait('branches', options),
    respond: ({ kind, options }) => {
      if (kind === failKind) {
        failures++;
        throw failure;
      }
      return wait(kind, options);
    },
  });
  return { ...f, ready, active, aborted, failure, get failures() { return failures; } };
}

for (const kind of KINDS) {
  test(`${kind}: transport rejection propagates and cancels/drains sibling requests`, { timeout: 3000 }, async (t) => {
    // A broken cancellation must not leave a real two-minute timer alive.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const f = hangingFixture(kind);
    await assert.rejects(f.run(), (err) => err === f.failure);
    assert.ok(f.failures >= 1 && f.failures <= 2, 'transport retries stay bounded');
    assert.deepEqual(f.aborted.slice().sort(), ['branches', ...KINDS.filter((k) => k !== kind)].sort());
    assert.equal(f.active.size, 0, 'cleanup finishes before rejection escapes');
    const count = f.calls.length;
    t.mock.timers.tick(120000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.length, count, 'no background retries after failure');
  });
}

test('120-second deadline cancels both GraphQL connections and REST branches before returning unknown', { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = hangingFixture();
  let settled = false;
  const running = f.run({ now: Date.now });
  running.then(() => { settled = true; }, () => { settled = true; });
  await Promise.race([f.ready.promise, running]);
  assert.equal(f.active.size, 3);
  t.mock.timers.tick(119999);
  assert.equal(settled, false);
  assert.equal(f.aborted.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(f.aborted.slice().sort(), ['branches', ...KINDS].sort());
  assert.equal(settled, false, 'must wait for asynchronous transport cleanup');
  const next = await running;
  assertUnknown(next);
  assert.equal(next.budgetExhausted, true);
  assert.equal(next.timeoutStage, '分支/PR/issue 列表');
  assert.equal(f.active.size, 0);
  const count = f.calls.length;
  t.mock.timers.tick(120000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, count);
});

test('remaining deadline bounds cursor requests and success at 120s is still unknown', { timeout: 3000 }, async () => {
  let clock = 0;
  const f = fixture({ pulls: rows('pulls', 51), respond: ({ kind, offset, options, result }) => {
    if (kind === 'pulls' && offset === 0) clock = 119999;
    if (kind === 'pulls' && offset === 50) {
      assert.ok(options.timeout <= 1, 'cursor page timeout must use the remaining budget');
      clock = 120000;
    }
    return result;
  } });
  const next = await f.run({ now: () => clock });
  assertUnknown(next);
  assert.equal(next.budgetExhausted, true);
  assert.equal(f.graphql.filter((c) => c.kind === 'pulls').length, 2);
});
