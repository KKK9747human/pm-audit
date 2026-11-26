import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const head = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);
const checks = (count, start = 1, overrides = {}) => Array.from({ length: count }, (_, i) => ({
  id: start + i, name: `check-${start + i}`, status: 'completed', conclusion: 'success', head_sha: head, ...overrides,
}));
const page = (total_count, check_runs) => ({ total_count, check_runs });

// Source modules are copied. The real gh module is never imported:
// both transports are replaced before native ESM loads ingest, with no subprocess,
// network, model, server, environment loading, or real project/cache access.
const mockGh = `
let fixture;
export const calls = [];
export function configure(value) { fixture = value; }
async function response(path, transport) {
  const url = new URL(path, 'https://fixture.invalid/');
  if (url.pathname.endsWith('/check-runs')) {
    const page = Number(url.searchParams.getAll('page').at(-1) || 1);
    calls.push({ path, transport, page, sizes: url.searchParams.getAll('per_page') });
    const value = fixture.pages[page - 1];
    if (page > fixture.pages.length) throw new Error('unexpected fixture page ' + page);
    if (value instanceof Error) throw value;
    return structuredClone(value);
  }
  if (url.pathname === '/repos/fixture/ci') return { full_name: 'fixture/ci', default_branch: 'main' };
  if (url.pathname === '/repos/fixture/ci/pulls') return [{
    number: 1, state: 'open', title: 'Synthetic PR', body: '',
    head: fixture.headSha == null ? undefined : { sha: fixture.headSha, ref: 'feature' },
  }];
  if (['/repos/fixture/ci/issues', '/repos/fixture/ci/branches',
       '/repos/fixture/ci/pulls/1/files', '/repos/fixture/ci/pulls/1/reviews'].includes(url.pathname)) return [];
  throw new Error('unexpected fixture endpoint ' + path);
}
export async function ghApi(path, { perPage = 100 } = {}) {
  // Mirror gh.mjs: it appends its own page size and returns object envelopes as-is.
  return response(path + (path.includes('?') ? '&' : '?') + 'per_page=' + perPage + '&page=1', 'ghApi');
}
export async function ghJson(path) { return response(path, 'ghJson'); }
`;

async function collect(t, pages, headSha = head) {
  const root = mkdtempSync(join(tmpdir(), 'pm-ci-ingest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['ingest.mjs', 'ci.mjs', 'project-lock.mjs']) {
    copyFileSync(new URL(`../src/${name}`, import.meta.url), join(root, name));
  }
  writeFileSync(join(root, 'gh.mjs'), mockGh, 'utf8');
  const mock = await import(pathToFileURL(join(root, 'gh.mjs')).href);
  mock.configure({ pages, headSha });
  const { ingest } = await import(pathToFileURL(join(root, 'ingest.mjs')).href);
  const { acquireProjectLock, releaseProjectLock } = await import(pathToFileURL(join(root, 'project-lock.mjs')).href);
  const lock = acquireProjectLock(root, 'synthetic');
  let raw;
  try {
    raw = await ingest({ id: 'synthetic', repo: 'fixture/ci', commitWindowDays: 7, maxBranchesToScan: 0 }, root, () => {}, lock);
  } finally {
    releaseProjectLock(lock);
  }
  const saved = JSON.parse(readFileSync(join(root, 'cache', 'synthetic', 'raw.json'), 'utf8'));
  assert.deepEqual(saved.pullDetails[1].checks, raw.pullDetails[1].checks);
  return { result: raw.pullDetails[1].checks, calls: mock.calls };
}

function flags(result, status, complete, truncated = false) {
  assert.ok(result, 'even missing head/acquisition must yield an explicit unknown summary');
  assert.equal(result.status, status);
  assert.equal(result.complete, complete);
  assert.equal(result.truncated, truncated);
  if (complete) assert.equal(result.collectionReason, null);
  else {
    assert.equal(typeof result.collectionReason, 'string');
    assert.ok(result.reason.includes(result.collectionReason));
  }
}

for (const count of [1, 50]) {
  test(`CI ingestion: total_count proves complete even at exact page size (${count})`, async (t) => {
    const { result, calls } = await collect(t, [page(count, checks(count))]);
    flags(result, 'passed', true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].sizes, ['50'], 'page size must not be overridden or duplicated');
    assert.equal(calls[0].page, 1);
  });
}

for (const total of [60, 101]) {
  test(`CI ingestion: all ${total} checks across multiple pages can pass`, async (t) => {
    const pages = Array.from({ length: Math.ceil(total / 50) }, (_, i) => page(total, checks(Math.min(50, total - i * 50), i * 50 + 1)));
    const { result, calls } = await collect(t, pages);
    flags(result, 'passed', true);
    assert.equal(result.checks.length, total);
    assert.deepEqual(calls.map((call) => call.page), pages.map((_, i) => i + 1));
    assert.ok(calls.every((call) => call.sizes.length === 1 && call.sizes[0] === '50'));
  });
}

for (const [conclusion, status] of [['success', 'unknown'], ['failure', 'failed'], ['pending', 'pending']]) {
  test(`CI ingestion: 30 of 50 never implies complete (${conclusion})`, async (t) => {
    const { result, calls } = await collect(t, [page(50, checks(30, 1, { conclusion }))]);
    flags(result, status, false, true);
    assert.match(result.collectionReason, /30.*50/);
    assert.match(result.collectionReason, /截断/);
    assert.equal(calls.length, 1, 'a short page with missing records is incomplete, not a guessed success');
  });
}

test('CI ingestion: an empty follow-up page cannot hide remaining total_count', async (t) => {
  const { result } = await collect(t, [page(70, checks(50)), page(70, [])]);
  flags(result, 'unknown', false, true);
  assert.match(result.collectionReason, /50.*70/);
});

for (const [conclusion, status] of [['success', 'unknown'], ['failure', 'failed'], ['pending', 'pending']]) {
  test(`CI ingestion: bounded collection exposes truncation (${conclusion})`, async (t) => {
    const pages = Array.from({ length: 3 }, (_, i) => page(151, checks(50, i * 50 + 1, { conclusion })));
    const { result, calls } = await collect(t, pages);
    flags(result, status, false, true);
    assert.equal(calls.length, 3);
    assert.match(result.collectionReason, /150.*151/);
    assert.match(result.collectionReason, /上限|截断/);
  });
}

for (const headSha of [null, '', 'a'.repeat(8), 'g'.repeat(40)]) {
  test(`CI ingestion: missing/invalid PR head stays unknown without a request (${headSha})`, async (t) => {
    const { result, calls } = await collect(t, [page(1, checks(1))], headSha);
    flags(result, 'unknown', false);
    assert.match(result.reason, /head.*40|40.*head/i);
    assert.equal(calls.length, 0);
  });
}

for (const head_sha of [oldHead, null, head.slice(0, 8)]) {
  test(`CI ingestion: missing/stale run source cannot pass (${head_sha})`, async (t) => {
    const { result } = await collect(t, [page(2, [...checks(1), ...checks(1, 2, { head_sha })])]);
    flags(result, 'unknown', false);
    assert.match(result.reason, /head/);
  });
}

test('CI ingestion: empty validated collection stays unknown', async (t) => {
  const { result } = await collect(t, [page(0, [])]);
  flags(result, 'unknown', true);
});

for (const [label, response] of [
  ['null response', null],
  ['array response', []],
  ['API error object', { message: 'fixture denied' }],
  ['missing check_runs', { total_count: 1 }],
  ['wrong check_runs type', page(1, {})],
  ['malformed run', page(2, [...checks(1), null])],
  ['missing total_count', { check_runs: checks(30) }],
  ['string total_count', page('1', checks(1))],
  ['negative total_count', page(-1, checks(1))],
  ['fractional total_count', page(1.5, checks(1))],
  ['returned exceeds total_count', page(0, checks(1))],
  ['oversized page', page(51, checks(51))],
  ['transport error', new Error('fixture transport offline')],
  ['malformed JSON error', new SyntaxError('fixture invalid JSON')],
]) {
  test(`CI ingestion: ${label} is unknown and incomplete`, async (t) => {
    const { result } = await collect(t, [response]);
    flags(result, 'unknown', false);
    assert.match(result.collectionReason, /格式|total_count|失败|超过/);
  });
}

for (const [conclusion, status] of [['success', 'unknown'], ['failure', 'failed'], ['pending', 'pending']]) {
  test(`CI ingestion: later transport failure retains matching evidence (${conclusion})`, async (t) => {
    const { result, calls } = await collect(t, [page(60, checks(50, 1, { conclusion })), new Error('fixture page two offline')]);
    flags(result, status, false);
    assert.equal(calls.length, 2);
    assert.equal(result.checks.length, 50);
    assert.match(result.collectionReason, /第 2 页.*失败/);
  });
}

for (const [label, response] of [
  ['total_count changes', page(51, checks(1, 51))],
  ['overlapping pages', page(60, checks(10, 1))],
  ['missing total on later page', { check_runs: checks(10, 51) }],
  ['malformed later page', { message: 'fixture invalid envelope' }],
]) {
  test(`CI ingestion: ${label} cannot prove complete`, async (t) => {
    const { result } = await collect(t, [page(60, checks(50)), response]);
    flags(result, 'unknown', false);
    assert.match(result.collectionReason, /total_count|重复|格式/);
  });
}
