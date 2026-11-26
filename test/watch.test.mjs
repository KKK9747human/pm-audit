import test from 'node:test';
import assert from 'node:assert/strict';
import { probeRemote, signatureOf, decideRefresh, backoffDelay, planRefresh, ownCommit, onlyOwnSince, classifyProbe } from '../src/watch.mjs';

const probe = (over) => ({
  pushedAt: '2026-11-20T10:00:00Z',
  defaultBranch: 'main',
  openPrs: ['3:2026-11-20T09:00:00Z:abc', '5:2026-11-20T08:00:00Z:def'],
  ...over,
});

test('signatureOf：与 open PR 顺序无关，pushed_at 或 PR 更新即变', () => {
  const a = signatureOf(probe());
  const b = signatureOf(probe({ openPrs: ['5:2026-11-20T08:00:00Z:def', '3:2026-11-20T09:00:00Z:abc'] }));
  assert.equal(a, b, '顺序不同指纹应相同');
  assert.notEqual(a, signatureOf(probe({ pushedAt: '2026-11-20T11:00:00Z' })));
  assert.notEqual(a, signatureOf(probe({ openPrs: ['3:2026-11-20T09:30:00Z:abc', '5:2026-11-20T08:00:00Z:def'] })));
  assert.equal(signatureOf(null), null);
});

test('decideRefresh：强制/首次/真变化都重算且 real=true', () => {
  const base = { prevSignature: 's0', nextSignature: 's0', fresh: false, tickCount: 1, fullEvery: 6 };
  assert.deepEqual(decideRefresh({ ...base, fresh: true }), { refresh: true, real: true, reason: '--fresh 强制' });
  assert.equal(decideRefresh({ ...base, prevSignature: null }).real, true);
  const changed = decideRefresh({ ...base, nextSignature: 's1' });
  assert.equal(changed.refresh, true);
  assert.equal(changed.real, true);
  assert.match(changed.reason, /远端有变化/);
});

test('decideRefresh：无变化跳过，到兜底轮才全量且 real=false（不写回）', () => {
  const base = { prevSignature: 's0', nextSignature: 's0', fresh: false, fullEvery: 6 };
  assert.equal(decideRefresh({ ...base, tickCount: 3 }).refresh, false);
  const net = decideRefresh({ ...base, tickCount: 6 });
  assert.equal(net.refresh, true);
  assert.equal(net.real, false, '兜底全量只本机刷新，不该触发写回');
  assert.equal(decideRefresh({ ...base, tickCount: 12 }).refresh, true);
  assert.equal(decideRefresh({ ...base, tickCount: 0 }).refresh, false, '第0轮不兜底');
  assert.equal(decideRefresh({ ...base, tickCount: 6, fullEvery: 0 }).refresh, false, 'fullEvery=0 关掉兜底');
});

test('planRefresh：自动轮次无变化跳过，只有真变化才写回', () => {
  // 自动轮次：远端无变化 → 跳过（不跑审计、不写回）
  assert.deepEqual(planRefresh({ auto: true, decision: { refresh: false, real: false } }), { skip: true, publish: false });
  // 自动轮次：兜底全量（real=false）→ 重算但不写回
  assert.deepEqual(planRefresh({ auto: true, decision: { refresh: true, real: false } }), { skip: false, publish: false });
  // 自动轮次：远端真变化 → 重算并写回
  assert.deepEqual(planRefresh({ auto: true, decision: { refresh: true, real: true } }), { skip: false, publish: true });
  // 手动刷新：从不跳过，但仍只有真变化才写回
  assert.deepEqual(planRefresh({ auto: false, decision: { refresh: false, real: false } }), { skip: false, publish: false });
  assert.deepEqual(planRefresh({ auto: false, decision: { refresh: true, real: true } }), { skip: false, publish: true });
});

test('backoffDelay：指数退避并封顶，非法失败数退回基准', () => {
  const I = 600000;
  assert.equal(backoffDelay(I, 0), I);
  assert.equal(backoffDelay(I, 1), I * 2);
  assert.equal(backoffDelay(I, 2), I * 4);
  assert.equal(backoffDelay(I, 3), I * 6, '封顶 maxFactor=6');
  assert.equal(backoffDelay(I, 9), I * 6);
  assert.equal(backoffDelay(I, -1), I);
  assert.equal(backoffDelay(I, NaN), I);
  assert.equal(backoffDelay(I, 2, 10), I * 4, '可自定义封顶');
});

const BASE = 'b'.repeat(40);
const OWN = 'a'.repeat(40);
const OWN2 = 'f'.repeat(40);
const ownMeta = (sha = OWN, parent = BASE) => ({
  sha, message: '[PM] Demo 数据包', parents: [parent],
  files: ['.pm/demo/manifest.json'], filesComplete: true,
});
const snapshot = (headSha = BASE, over = {}) => ({
  pushedAt: '2026-11-20T10:00:00Z', defaultBranch: 'main', repositoryDefaultBranch: 'main',
  headSha, branches: [{ name: 'main', sha: headSha }], openPrs: [], openIssues: [],
  snapshotComplete: true, ...over,
});
const delta = (over = {}) => snapshot(OWN, {
  pushedAt: '2026-11-20T11:00:00Z', compareBase: BASE, compareHead: OWN,
  recentCommits: [ownMeta()], commitsComplete: true, ...over,
});
const classify = (nextProbe, prevProbe = snapshot()) => classifyProbe({
  prevProbe, nextProbe, knownOwn: new Set([OWN, OWN2]), projectId: 'demo',
});

test('自身提交必须匹配实际PM前缀、登记SHA、单父提交和当前项目路径', () => {
  assert.equal(ownCommit(ownMeta(), new Set([OWN]), 'demo').own, true);
  for (const patch of [
    { sha: 'short' }, { message: '普通提交' }, { parents: [] }, { parents: [BASE, OWN2] },
    { files: ['src/app.js'] }, { files: ['.pm/other/manifest.json'] },
    { files: ['.pm/demo/../other/x'] }, { filesComplete: false }, { files: [] },
  ]) assert.equal(ownCommit({ ...ownMeta(), ...patch }, new Set([OWN]), 'demo').own, false);
  assert.equal(ownCommit(ownMeta(), new Set(), 'demo').own, false);
});

test('自身增量沿父链遍历，不按SHA字符排序，不能漏掉额外提交', () => {
  const options = { headSha: OWN2, projectId: 'demo', complete: true };
  const known = new Set([OWN, OWN2]);
  const commits = [ownMeta(OWN2, OWN), ownMeta()];
  assert.equal(onlyOwnSince(commits, BASE, known, options).ownOnly, true);
  assert.equal(onlyOwnSince(commits.reverse(), BASE, known, options).ownOnly, true);
  assert.equal(onlyOwnSince([ownMeta(OWN2, BASE), ownMeta()], BASE, known, options).ownOnly, false);
  assert.equal(onlyOwnSince(commits, BASE, known, { ...options, complete: false }).unknown, true);
  assert.equal(onlyOwnSince(commits, BASE, known, { ...options, maxCommits: 1 }).unknown, true);
});

test('只有默认分支完整自身增量且其他证据没变才可忽略', () => {
  assert.equal(classify(delta()).ownOnly, true);
  assert.equal(classify(delta({ openPrs: ['2:new:sha'] })).ownOnly, false);
  assert.equal(classify(delta({ openIssues: ['1:updated'] })).ownOnly, false);
  assert.equal(classify(delta({ branches: [{ name: 'main', sha: OWN }, { name: 'task/A1', sha: OWN2 }] })).ownOnly, false);
  assert.equal(classify(delta({ defaultBranch: 'dev' })).ownOnly, false);
  assert.equal(classify(delta({ commitsComplete: false })).unknown, true);
  assert.equal(classify(delta({ compareBase: OWN2 })).unknown, true);
  assert.equal(classify(delta(), null).ownOnly, false);
});

test('无变化不依赖历史提交条数，首次完整快照可审计，不完整快照未知', () => {
  const same = snapshot(BASE, { recentCommits: Array.from({ length: 20 }, () => ownMeta()), commitsComplete: false });
  assert.equal(classify(same).changed, false);
  assert.equal(classify(same).unknown, false);
  assert.equal(classify(snapshot(), null).unknown, false);
  assert.equal(classify(snapshot(BASE, { snapshotComplete: false })).unknown, true);
});

test('签名覆盖分支和issue，但不受对比窗口变化影响', () => {
  assert.equal(signatureOf(snapshot()), signatureOf(snapshot(BASE, { recentCommits: [ownMeta()], commitsComplete: false })));
  assert.notEqual(signatureOf(snapshot()), signatureOf(snapshot(BASE, { branches: [{ name: 'task/A2', sha: OWN }] })));
  assert.notEqual(signatureOf(snapshot()), signatureOf(snapshot(BASE, { openIssues: ['1:new'] })));
});

const remoteIssue = (over = {}) => ({
  number: 1, title: '[A1] Demo task', body: 'pm-node: A1', state: 'open',
  updated_at: '2026-11-20T10:00:00Z', closed_at: null, ...over,
});
const remotePull = (over = {}) => ({
  ...remoteIssue({ number: 3 }), merged_at: null, merge_commit_sha: null,
  head: { sha: OWN2, ref: 'task/A1' }, base: { sha: BASE, ref: 'main' }, ...over,
});

const requestLabel = (url, opts) => url === 'graphql'
  ? `graphql/${opts.body.query.includes('pullRequests(') ? 'pulls' : 'issues'}?after=${opts.body.variables.after || ''}` : url;
const emptyGraph = () => ({ data: { repository: {
  nameWithOwner: 'fixture/never-contact', entries: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
} } });
const graphNode = (item, kind) => item == null ? null : {
  number: item.number, title: item.title, body: item.body,
  state: typeof item.state === 'string' ? item.state.toUpperCase() : item.state,
  updated_at: item.updated_at, closed_at: item.closed_at,
  ...(kind === 'pulls' ? {
    merged_at: item.merged_at,
    mergeCommit: item.merge_commit_sha === null ? null : { oid: item.merge_commit_sha },
    headRefOid: item.head?.sha, headRefName: item.head?.ref,
    baseRefOid: item.base?.sha, baseRefName: item.base?.ref,
  } : {}),
};

function remoteFixture({ head = OWN, compare, files, branches, pulls, issues } = {}) {
  const calls = [];
  const request = async (url, opts) => {
    calls.push(requestLabel(url, opts));
    if (url === 'repos/fixture/never-contact') return { pushed_at: '2026-11-20T11:00:00Z', default_branch: 'main' };
    if (url === 'graphql') {
      const kind = opts.body.query.includes('pullRequests(') ? 'pulls' : 'issues';
      const source = kind === 'pulls' ? pulls : issues;
      const items = [];
      for (let page = 1; page <= 21; page++) {
        const data = source ? source(page, 50) : [];
        items.push(...data);
        if (data.length < 50) break;
      }
      const filtered = kind === 'issues' ? items.filter((item) => !item?.pull_request) : items;
      const offset = opts.body.variables.after === null ? 0 : Number(opts.body.variables.after);
      const nodes = filtered.slice(offset, offset + 50).map((item) => graphNode(item, kind));
      return { data: { repository: { nameWithOwner: 'fixture/never-contact', entries: {
        totalCount: filtered.length, nodes,
        pageInfo: { hasNextPage: offset + nodes.length < filtered.length, endCursor: nodes.length ? String(offset + nodes.length) : null },
      } } } };
    }
    const params = new URL('https://fixture.invalid/' + url).searchParams;
    const page = Number(params.get('page'));
    const perPage = Number(params.get('per_page'));
    assert.equal(perPage, 100);
    if (url.includes('/branches?')) return branches ? branches(page, perPage) : [{ name: 'main', commit: { sha: head } }];
    if (url.includes('/compare/')) return compare ? compare(page) : {
      status: 'ahead', total_commits: 1, merge_base_commit: { sha: BASE },
      commits: [{ sha: OWN, parents: [{ sha: BASE }], commit: { message: '[PM] Demo 数据包' } }],
    };
    if (url.includes(`/commits/${OWN}?`)) return files ? files(page) : {
      sha: OWN, parents: [{ sha: BASE }], files: [{ filename: '.pm/demo/manifest.json' }],
    };
    assert.fail(`unexpected API access: ${url}`);
  };
  return { calls, request, run: (options = {}) => probeRemote({ id: 'demo', repo: 'fixture/never-contact' }, {
    prevProbe: snapshot(), knownOwn: new Set([OWN]), request, ...options,
  }) };
}

test('远端探针首次或head不变不拉最近历史，正常长仓库不再未知', async () => {
  const f = remoteFixture({ head: BASE });
  const current = await f.run();
  assert.equal(current.snapshotComplete, true);
  assert.equal(f.calls.some((url) => url.includes('/commits') || url.includes('/compare')), false);
  const initial = await f.run({ prevProbe: null });
  assert.equal(classify(initial, null).unknown, false);
});

test('远端探针使用固定base/head对比，并采集已登记写回的文件证据', async () => {
  const f = remoteFixture();
  const current = await f.run();
  assert.equal(current.commitsComplete, true);
  assert.equal(classify(current).ownOnly, true);
  assert.ok(f.calls.some((url) => url.includes(`/compare/${BASE}...${OWN}?`)));
});

test('超过100个真实增量按页读全，短页却未达到total不能冒充完整', async () => {
  const commits = Array.from({ length: 101 }, (_, i) => ({
    sha: i === 100 ? OWN : (i + 1).toString(16).padStart(40, '0'),
    parents: [{ sha: BASE }], commit: { message: 'developer change' },
  }));
  const response = (page) => ({
    status: 'ahead', total_commits: 101, merge_base_commit: { sha: BASE }, commits: commits.slice((page - 1) * 100, page * 100),
  });
  const f = remoteFixture({ compare: response });
  const current = await f.run();
  assert.equal(current.recentCommits.length, 101);
  assert.equal(current.commitsComplete, true);
  assert.equal(classify(current).unknown, false);
  assert.equal(classify(current).ownOnly, false);
  const short = await remoteFixture({ compare: () => ({ ...response(1), commits: commits.slice(0, 20) }) }).run();
  assert.equal(short.commitsComplete, false);
  assert.equal(classify(short).unknown, true);
});

test('远端对比错误、文件截断、改名来自源码目录都不能识别为自身写回', async () => {
  const failed = await remoteFixture({ compare: () => { throw new Error('fixture offline'); } }).run();
  assert.equal(classify(failed).unknown, true);
  const truncated = await remoteFixture({ files: () => ({
    sha: OWN, parents: [{ sha: BASE }], files: Array.from({ length: 100 }, (_, i) => ({ filename: `.pm/demo/${i}.md` })),
  }) }).run();
  assert.equal(classify(truncated).unknown, true);
  const renamed = await remoteFixture({ files: () => ({
    sha: OWN, parents: [{ sha: BASE }], files: [{ filename: '.pm/demo/copied.js', previous_filename: 'src/app.js' }],
  }) }).run();
  assert.equal(classify(renamed).ownOnly, false);
});

test('PR和issue用GraphQL读全，包括第五页已关闭记录', async () => {
  for (const [source, field, make] of [
    ['pulls', 'openPrs', remotePull], ['issues', 'openIssues', remoteIssue],
  ]) {
    const items = Array.from({ length: 201 }, (_, i) => make({
      number: i + 1, state: 'closed', closed_at: '2026-11-20T10:00:00Z',
    }));
    const f = remoteFixture({ head: BASE, [source]: (page, perPage) => items.slice((page - 1) * perPage, page * perPage) });
    const previous = await f.run();
    assert.equal(previous.snapshotComplete, true, source);
    assert.equal(previous[field].length, 201, source);
    assert.equal(f.calls.filter((url) => url.includes(`/${source}?`)).length, 5, source);
    items[200] = { ...items[200], body: 'pm-node: B2' };
    const next = await f.run({ prevProbe: previous });
    assert.equal(classify(next, previous).changed, true, source);
  }
});

test('分支分页耗尽或PR/issue超出容量时未知，不能当作无变化或自身写回', async () => {
  for (const [source, make] of [
    ['pulls', (i) => remotePull({ number: i })],
    ['issues', (i) => remoteIssue({ number: i })],
    ['branches', (i) => ({ name: i === 1 ? 'main' : `task/${i}`, commit: { sha: OWN } })],
  ]) {
    const f = remoteFixture({
      [source]: (page, perPage) => Array.from({ length: perPage }, (_, i) => make((page - 1) * perPage + i + 1)),
    });
    const capped = await f.run();
    assert.equal(capped.snapshotComplete, false, source);
    assert.equal(classify(capped).unknown, true, source);
    assert.equal(classify(capped).ownOnly, false, source);
    assert.equal(classify(capped, capped).unknown, true, source);
    assert.equal(f.calls.filter((url) => url.includes(`/${source}?`)).length, source === 'branches' ? 10 : 1, source);
    assert.equal(f.calls.some((url) => url.includes('/compare/') || url.includes('/commits/')), false, source);
  }
});

test('已关闭issue映射正文编辑，即使时间戳相同且仅有PM提交也是真变化', async () => {
  const issue = remoteIssue({ state: 'closed', closed_at: '2026-11-20T10:00:00Z' });
  const previous = await remoteFixture({ head: BASE, issues: () => [issue] }).run();
  const next = await remoteFixture({ issues: () => [{ ...issue, body: 'pm-node: B2' }] }).run({ prevProbe: previous });
  assert.equal(next.snapshotComplete, true);
  assert.equal(next.commitsComplete, true);
  assert.notEqual(signatureOf(previous), signatureOf(next));
  const result = classify(next, previous);
  assert.equal(result.changed, true);
  assert.equal(result.ownOnly, false);
  assert.equal(result.unknown, false);
});

test('已关闭PR正文或标题编辑不会被同轮PM提交吞掉', async () => {
  const pull = remotePull({ state: 'closed', closed_at: '2026-11-20T10:00:00Z' });
  const previous = await remoteFixture({ head: BASE, pulls: () => [pull] }).run();
  for (const patch of [{ body: 'pm-node: B2' }, { title: '[B2] Revised task' }]) {
    const next = await remoteFixture({ pulls: () => [{ ...pull, ...patch }] }).run({ prevProbe: previous });
    assert.equal(next.snapshotComplete, true);
    assert.equal(next.commitsComplete, true);
    assert.equal(classify(next, previous).changed, true);
    assert.equal(classify(next, previous).ownOnly, false);
    assert.equal(classify(next, previous).unknown, false);
  }
});

test('两轮之间关闭或新建后立即关闭的issue和PR仍然触发审计', async () => {
  for (const [source, make] of [['issues', remoteIssue], ['pulls', remotePull]]) {
    const item = make();
    for (const before of [[], [item]]) {
      const previous = await remoteFixture({ head: BASE, [source]: () => before }).run();
      const next = await remoteFixture({
        [source]: () => [{ ...item, state: 'closed', closed_at: item.updated_at }],
      }).run({ prevProbe: previous });
      assert.equal(next.snapshotComplete, true, source);
      assert.equal(next.commitsComplete, true, source);
      assert.equal(classify(next, previous).changed, true, source);
      assert.equal(classify(next, previous).ownOnly, false, source);
      assert.equal(classify(next, previous).unknown, false, source);
    }
  }
});

test('签名逐字段覆盖状态、时间、正文及PR合并和head/base证据', async () => {
  const changes = [
    { state: 'closed' }, { title: '[B2] Revised task' }, { body: null },
    { updated_at: '2026-11-20T11:00:00Z' }, { closed_at: '2026-11-20T10:00:00Z' },
  ];
  for (const [source, make, patches] of [
    ['issues', remoteIssue, changes],
    ['pulls', remotePull, [...changes,
      { merged_at: '2026-11-20T10:00:00Z' }, { state: 'closed', merge_commit_sha: OWN },
      { head: { sha: OWN, ref: 'task/A1' } }, { head: { sha: OWN2, ref: 'task/B2' } },
      { base: { sha: BASE, ref: 'release' } },
    ]],
  ]) {
    const item = make();
    const previous = await remoteFixture({ head: BASE, [source]: () => [item] }).run();
    for (const patch of patches) {
      const label = `${source}: ${Object.keys(patch)[0]}`;
      const next = await remoteFixture({ [source]: () => [{ ...item, ...patch }] }).run({ prevProbe: previous });
      assert.equal(next.snapshotComplete, true, label);
      assert.notDeepEqual(next[source === 'pulls' ? 'openPrs' : 'openIssues'], previous[source === 'pulls' ? 'openPrs' : 'openIssues'], label);
      assert.equal(classify(next, previous).changed, true, label);
      assert.equal(classify(next, previous).ownOnly, false, label);
      assert.equal(classify(next, previous).unknown, false, label);
    }
  }
});

test('完整未变快照不受记录或对象字段顺序影响，也不误报PM自身写回', async () => {
  const pulls = [remotePull(), remotePull({
    number: 4, state: 'closed', closed_at: '2026-11-20T10:00:00Z', merged_at: '2026-11-20T10:00:00Z',
  })];
  const issues = [remoteIssue({ body: null }), remoteIssue({
    number: 2, state: 'closed', closed_at: '2026-11-20T10:00:00Z',
  }), remoteIssue({ number: 3, pull_request: { url: 'fixture' } })];
  const previous = await remoteFixture({ head: BASE, pulls: () => pulls, issues: () => issues }).run();
  const reorder = (items) => items.map((item) => ({
    ...Object.fromEntries(Object.entries(item).reverse()), ignored_metadata: 'not audited',
  })).reverse();
  const sources = { pulls: () => reorder(pulls), issues: () => reorder(issues) };
  const next = await remoteFixture({ head: BASE, ...sources }).run({ prevProbe: previous });
  assert.equal(previous.snapshotComplete, true);
  assert.equal(next.snapshotComplete, true);
  assert.equal(next.openIssues.length, 2);
  assert.equal(signatureOf(next), signatureOf(previous));
  assert.equal(classify(next, previous).changed, false);
  assert.equal(classify(next, previous).unknown, false);
  const own = await remoteFixture(sources).run({ prevProbe: previous });
  assert.equal(classify(own, previous).ownOnly, true);
  assert.equal(classify(own, previous).unknown, false);
});

test('PM 推进默认分支使开放 PR 的 base 与试合并 SHA 改变，不应触发写回循环', async () => {
  const pull = remotePull();
  const previous = await remoteFixture({ head: BASE, pulls: () => [pull] }).run();
  const next = await remoteFixture({ pulls: () => [{ ...pull, base: { ...pull.base, sha: OWN }, merge_commit_sha: OWN2 }] }).run({ prevProbe: previous });
  assert.equal(next.snapshotComplete, true);
  assert.equal(classify(next, previous).ownOnly, true);
  const closed = { ...pull, state: 'closed', closed_at: pull.updated_at, merge_commit_sha: BASE };
  const before = await remoteFixture({ head: BASE, pulls: () => [closed] }).run();
  const after = await remoteFixture({ pulls: () => [{ ...closed, merge_commit_sha: OWN }] }).run({ prevProbe: before });
  assert.equal(classify(after, before).changed, true);
});

test('缺失或非法审计必需字段返回未知，而不是未变或PM自身写回', async () => {
  const commonFields = ['number', 'state', 'title', 'body', 'updated_at', 'closed_at'];
  for (const [source, make, fields] of [
    ['issues', remoteIssue, commonFields],
    ['pulls', remotePull, [...commonFields, 'merged_at', 'merge_commit_sha', 'head', 'base', 'head.sha', 'head.ref', 'base.sha', 'base.ref']],
  ]) {
    const previous = await remoteFixture({ head: BASE, [source]: () => [make()] }).run();
    const invalid = fields.map((field) => {
      const item = make();
      const path = field.split('.');
      const target = path.length === 1 ? item : item[path[0]];
      delete target[path.at(-1)];
      return [field, item];
    });
    invalid.push(['null record', null], ['invalid body', make({ body: 42 })],
      ['invalid state', make({ state: 'unknown' })], ['empty timestamp', make({ updated_at: '' })]);
    for (const [field, item] of invalid) {
      for (const head of [BASE, OWN]) {
        const label = `${source}: ${field}: ${head}`;
        const next = await remoteFixture({ head, [source]: () => [item] }).run({ prevProbe: previous });
        assert.equal(next.snapshotComplete, false, label);
        assert.equal(classify(next, previous).unknown, true, label);
        assert.equal(classify(next, previous).ownOnly, false, label);
        assert.equal(classify(next, next).unknown, true, label);
      }
    }
  }
});

const T_BASE = '1'.repeat(40);
const T_MAIN = '2'.repeat(40);
const T_PM_OLD = '3'.repeat(40);
const T_PM_NEW = '4'.repeat(40);
const T_OLD = '5'.repeat(40);
const T_NEW = '6'.repeat(40);
const T_SRC = '7'.repeat(40);

function smallPayloadFixture({ compareFails = true, filesFail = true, list, tree, projectId = 'demo' } = {}) {
  const calls = [];
  const request = async (url, opts) => {
    calls.push(requestLabel(url, opts));
    if (url === 'repos/fixture/never-contact') return { pushed_at: '2026-11-20T11:00:00Z', default_branch: 'main' };
    if (url === 'graphql') return emptyGraph();
    const params = new URL('https://fixture.invalid/' + url).searchParams;
    if (url.includes('/branches?')) return [{ name: 'main', commit: { sha: OWN } }];
    if (url.includes('/compare/')) {
      if (compareFails) throw new Error('large payload reset');
      return {
        status: 'ahead', total_commits: 1, merge_base_commit: { sha: BASE },
        commits: [{ sha: OWN, parents: [{ sha: BASE }], commit: { message: '[PM] Demo 数据包' } }],
      };
    }
    if (url.includes('/commits?sha=')) {
      return list ? list(Number(params.get('page'))) : [{
        sha: OWN, parents: [{ sha: BASE }],
        commit: { message: '[PM] Demo 数据包', tree: { sha: T_NEW } },
      }];
    }
    if (url.includes('/git/commits/')) {
      const sha = url.split('/').at(-1);
      return tree?.commit(sha) || {
        sha, parents: sha === OWN ? [{ sha: BASE }] : [], tree: { sha: sha === OWN ? T_NEW : T_MAIN },
      };
    }
    if (url.includes('/git/trees/')) return tree?.tree(url.split('/').at(-1));
    if (url.includes(`/commits/${OWN}?`)) {
      if (filesFail) throw new Error('large payload reset');
      return { sha: OWN, parents: [{ sha: BASE }], files: [] };
    }
    assert.fail(`unexpected API access: ${url}`);
  };
  return {
    calls,
    run: (options = {}) => probeRemote({ id: projectId, repo: 'fixture/never-contact' }, {
      prevProbe: snapshot(), knownOwn: new Set([OWN]), request, ...options,
    }),
  };
}

const treeFixture = (patch = {}) => ({
  commit: (sha) => sha === OWN
    ? { sha: OWN, parents: [{ sha: BASE }], tree: { sha: T_NEW } }
    : { sha: BASE, parents: [], tree: { sha: T_MAIN } },
  tree: (sha) => ({
    [T_MAIN]: { sha: T_MAIN, tree: [{ path: '.pm', type: 'tree', mode: '40000', sha: T_PM_OLD }, { path: 'src', type: 'tree', mode: '40000', sha: T_SRC }] },
    [T_NEW]: { sha: T_NEW, tree: [{ path: '.pm', type: 'tree', mode: '40000', sha: T_PM_NEW }, { path: 'src', type: 'tree', mode: '40000', sha: T_SRC }] },
    [T_PM_OLD]: { sha: T_PM_OLD, tree: [{ path: 'demo', type: 'tree', mode: '40000', sha: T_OLD }] },
    [T_PM_NEW]: { sha: T_PM_NEW, tree: [{ path: 'demo', type: 'tree', mode: '40000', sha: T_NEW }] },
  })[sha],
  ...patch,
});

test('大响应被重置时改用提交列表与树逐层证明自身写回', async () => {
  const f = smallPayloadFixture({ tree: treeFixture() });
  const next = await f.run();
  assert.equal(next.commitsComplete, true);
  assert.equal(classify(next, snapshot()).ownOnly, true);
  assert.equal(classify(next, snapshot()).unknown, false);
  assert.ok(f.calls.some((url) => url.includes('/commits?sha=')));
  assert.ok(f.calls.some((url) => url.includes('/git/trees/')));
});

test('树比对发现 .pm 之外的改动仍然算真实变化', async () => {
  const tree = treeFixture({
    tree: (sha) => {
      const value = treeFixture().tree(sha);
      if (sha !== T_NEW) return value;
      return { sha: T_NEW, tree: [{ path: '.pm', type: 'tree', mode: '40000', sha: T_PM_NEW }, { path: 'src', type: 'tree', mode: '40000', sha: T_BASE }] };
    },
  });
  const next = await smallPayloadFixture({ tree }).run();
  const result = classify(next, snapshot());
  assert.equal(result.ownOnly, false);
  assert.equal(result.changed, true);
});

test('树比对发现 .pm 下其他项目改动也不认作自身写回', async () => {
  const tree = treeFixture({
    tree: (sha) => {
      const value = treeFixture().tree(sha);
      if (sha !== T_PM_NEW) return value;
      return { sha: T_PM_NEW, tree: [{ path: 'demo', type: 'tree', mode: '40000', sha: T_NEW }, { path: 'other', type: 'tree', mode: '40000', sha: T_OLD }] };
    },
  });
  const next = await smallPayloadFixture({ tree }).run();
  assert.equal(classify(next, snapshot()).ownOnly, false);
  assert.equal(classify(next, snapshot()).changed, true);
});

test('提交列表无法连到旧基准时按历史变化处理，不冒充自身写回', async () => {
  const other = '9'.repeat(40);
  const next = await smallPayloadFixture({
    tree: treeFixture(),
    list: () => [
      { sha: OWN, parents: [{ sha: other }], commit: { message: '[PM] Demo 数据包', tree: { sha: T_NEW } } },
      { sha: other, parents: [], commit: { message: 'rewritten', tree: { sha: T_OLD } } },
    ],
  }).run();
  assert.equal(classify(next, snapshot()).changed, true);
  assert.equal(classify(next, snapshot()).ownOnly, false);
});

test('提交详情不可读但树证据完整时，已登记写回仍可识别', async () => {
  const next = await smallPayloadFixture({ compareFails: false, filesFail: true, tree: treeFixture() }).run();
  assert.equal(next.commitsComplete, true);
  assert.equal(classify(next, snapshot()).ownOnly, true);
  assert.ok(next.recentCommits[0].scopeVerified === true);
});

test('树条目非法时保持未知，不猜测自身写回', async () => {
  const tree = treeFixture({
    tree: (sha) => sha === T_MAIN
      ? { sha: T_MAIN, tree: [{ path: 'src/nested', type: 'tree', mode: '40000', sha: T_SRC }, { path: '.pm', type: 'tree', mode: '40000', sha: T_PM_OLD }] }
      : treeFixture().tree(sha),
  });
  const next = await smallPayloadFixture({ tree }).run();
  assert.equal(next.commitsComplete, false);
  assert.equal(classify(next, snapshot()).unknown, true);
});

test('树被截断时即使内容看起来只有 PM 文件也保持未知', async () => {
  const tree = treeFixture({
    tree: (sha) => sha === T_MAIN
      ? { sha: T_MAIN, truncated: true, tree: [{ path: '.pm', type: 'tree', mode: '40000', sha: T_PM_OLD }] }
      : treeFixture().tree(sha),
  });
  const next = await smallPayloadFixture({ tree }).run();
  assert.equal(next.commitsComplete, false);
  assert.equal(classify(next, snapshot()).unknown, true);
  assert.equal(classify(next, snapshot()).ownOnly, false);
});

for (const [label, entry] of [
  ['重复路径', { path: '.pm', type: 'tree', mode: '40000', sha: T_PM_OLD }],
  ['mode 与类型不匹配', { path: '.pm', type: 'tree', mode: '100644', sha: T_PM_OLD }],
  ['缺少 mode', { path: '.pm', type: 'tree', sha: T_PM_OLD }],
  ['未知类型', { path: '.pm', type: 'weird', mode: '100644', sha: T_PM_OLD }],
]) {
  test(`树条目${label}时保持未知`, async () => {
    const tree = treeFixture({
      tree: (sha) => sha === T_MAIN
        ? { sha: T_MAIN, tree: entry.path === '.pm' && label === '重复路径' ? [entry, { ...entry }] : [entry] }
        : treeFixture().tree(sha),
    });
    const next = await smallPayloadFixture({ tree }).run();
    assert.equal(next.commitsComplete, false, label);
    assert.equal(classify(next, snapshot()).unknown, true, label);
    assert.equal(classify(next, snapshot()).ownOnly, false, label);
  });
}

test('根目录可执行位变化算真实变化', async () => {
  const tree = treeFixture({
    tree: (sha) => {
      if (sha !== T_MAIN) return treeFixture().tree(sha);
      return {
        sha: T_MAIN,
        tree: [
          { path: '.pm', type: 'tree', mode: '40000', sha: T_PM_OLD },
          { path: 'run.sh', type: 'blob', mode: '100755', sha: T_SRC },
        ],
      };
    },
  });
  const bumped = treeFixture({
    tree: (sha) => {
      if (sha !== T_NEW) return tree.tree(sha);
      return {
        sha: T_NEW,
        tree: [
          { path: '.pm', type: 'tree', mode: '40000', sha: T_PM_NEW },
          { path: 'run.sh', type: 'blob', mode: '100644', sha: T_SRC },
        ],
      };
    },
  });
  const next = await smallPayloadFixture({ tree: bumped }).run();
  assert.equal(classify(next, snapshot()).ownOnly, false);
  assert.equal(classify(next, snapshot()).changed, true);
});

test('未变化的子模块不影响自身写回，变化的子模块算真实变化', async () => {
  const gitlink = (sha) => ({ path: 'vendorlib', type: 'commit', mode: '160000', sha });
  const withLink = (sha, linkSha) => {
    const value = treeFixture().tree(sha);
    return { sha, tree: [...value.tree, gitlink(linkSha)] };
  };
  const same = treeFixture({
    tree: (sha) => withLink(sha, T_SRC),
  });
  const sameNext = await smallPayloadFixture({ tree: same }).run();
  assert.equal(classify(sameNext, snapshot()).ownOnly, true);

  const moved = treeFixture({
    tree: (sha) => withLink(sha, sha === T_NEW ? T_OLD : T_SRC),
  });
  const movedNext = await smallPayloadFixture({ tree: moved }).run();
  assert.equal(classify(movedNext, snapshot()).ownOnly, false);
  assert.equal(classify(movedNext, snapshot()).changed, true);
});

test('.pm 或项目目录被换成子模块/文件时不算自身写回', async () => {
  const asGitlink = treeFixture({
    tree: (sha) => sha === T_NEW
      ? { sha: T_NEW, tree: [{ path: '.pm', type: 'commit', mode: '160000', sha: T_PM_NEW }, { path: 'src', type: 'tree', mode: '40000', sha: T_SRC }] }
      : treeFixture().tree(sha),
  });
  const next = await smallPayloadFixture({ tree: asGitlink }).run();
  assert.equal(classify(next, snapshot()).ownOnly, false);
  assert.equal(classify(next, snapshot()).changed, true);
});

test('大响应失败只试一次就回退小请求', async () => {
  const f = smallPayloadFixture({ tree: treeFixture() });
  const next = await f.run();
  assert.equal(next.commitsComplete, true);
  assert.equal(f.calls.filter((url) => url.includes('/compare/')).length, 1, 'compare 只试一次');
  assert.equal(f.calls.filter((url) => url.includes(`/commits/${OWN}?`)).length, 1, '提交详情只试一次');
  assert.ok(f.calls.some((url) => url.includes('/commits?sha=')), '回退到提交列表');
});

test('提交链走到旧基准就停止，不再读更早历史', async () => {
  const filler = Array.from({ length: 99 }, (_, i) => ({
    sha: (i + 2).toString(16).padStart(40, '0'),
    parents: [{ sha: BASE }], commit: { message: '历史提交', tree: { sha: T_MAIN } },
  }));
  const f = smallPayloadFixture({
    tree: treeFixture(),
    list: () => [{
      sha: OWN, parents: [{ sha: BASE }],
      commit: { message: '[PM] Demo 数据包', tree: { sha: T_NEW } },
    }, ...filler],
  });
  const next = await f.run();
  assert.equal(next.commitsComplete, true);
  assert.equal(next.recentCommits.length, 1);
  assert.equal(f.calls.filter((url) => url.includes('/commits?sha=')).length, 1, '一页就连上旧基准');
});

test('探针有总时间预算，耗尽返回未知并说明阶段', async () => {
  const BUDGET = 120000;
  let t = 0;
  const calls = [];
  // 假请求按超时扣虚拟时间：前几个阶段成功但慢，把预算吃光。
  const request = async (url, opts) => {
    calls.push({ url, timeout: opts.timeout });
    t += opts.timeout;
    if (url === 'repos/fixture/never-contact') return { pushed_at: '2026-11-20T11:00:00Z', default_branch: 'main' };
    if (url.includes('/branches?')) return [{ name: 'main', commit: { sha: OWN } }];
    if (url === 'graphql') return emptyGraph();
    throw new Error(`unexpected ${url}`);
  };
  const prev = snapshot();
  const next = await probeRemote({ id: 'demo', repo: 'fixture/never-contact' }, {
    prevProbe: prev, knownOwn: new Set([OWN]), request,
    now: () => t, sleep: async (ms) => { t += ms; },
  });
  assert.equal(next.budgetExhausted, true);
  assert.equal(next.timeoutStage, '分支/PR/issue 列表');
  assert.equal(next.snapshotComplete, false);
  const result = classifyProbe({ prevProbe: prev, nextProbe: next, knownOwn: new Set([OWN]), projectId: 'demo' });
  assert.equal(result.unknown, true);
  assert.match(result.reason, /预算耗尽/);
  assert.ok(t <= BUDGET, `虚拟耗时 ${t} 超过总预算 ${BUDGET}`);
  assert.ok(calls.every((call) => call.timeout <= 30000), '小请求单次最多30秒');
});

test('小请求失败重试两次后仍失败则抛出，不无限重试', async () => {
  const attempts = [];
  const request = async (url, opts) => {
    if (url === 'repos/fixture/never-contact') {
      attempts.push(opts.timeout);
      throw new Error('fixture flaky');
    }
    return {};
  };
  await assert.rejects(probeRemote({ id: 'demo', repo: 'fixture/never-contact' }, {
    prevProbe: snapshot(), knownOwn: new Set([OWN]), request,
    now: () => 0, sleep: async () => {},
  }), /fixture flaky/);
  assert.equal(attempts.length, 2, '小请求最多两次');
});

for (const count of [0, 5, 6, 20, 21, 50, 51, 999]) {
  test(`GraphQL游标分页保留 ${count} 条PR/issue的完整证据`, async () => {
    const items = Array.from({ length: count }, (_, i) => remotePull({ number: i + 1 }));
    const pageOf = (page, perPage) => items.slice((page - 1) * perPage, page * perPage);
    const f = remoteFixture({ head: BASE, pulls: pageOf, issues: pageOf });
    const next = await f.run();
    assert.equal(next.snapshotComplete, true);
    assert.equal(next.openPrs.length, count);
    assert.equal(next.openIssues.length, count);
    for (const source of ['pulls', 'issues']) {
      assert.equal(f.calls.filter((url) => url.includes(`/${source}?`)).length, Math.max(1, Math.ceil(count / 50)));
    }
  });
}

for (const outcome of ['success', 'timeout']) {
  test(`最后一次请求在预算边界${outcome}，也必须返回未知`, async () => {
    let clock = 0;
    let calls = 0;
    const next = await probeRemote({ id: 'demo', repo: 'fixture/never-contact' }, {
      now: () => clock,
      sleep: async () => {},
      request: async () => {
        calls++;
        if (outcome === 'success' || calls === 2) clock = 120000;
        if (outcome === 'timeout') throw Object.assign(new Error('transport timeout'), { code: 'GH_TIMEOUT' });
        return { pushed_at: '2026-11-20T11:00:00Z', default_branch: 'main' };
      },
    });
    assert.equal(next.budgetExhausted, true);
    assert.equal(next.timeoutStage, '仓库元数据');
    assert.equal(classify(next).unknown, true);
    assert.equal(calls, outcome === 'success' ? 1 : 2);
  });
}

for (const [target, stage] of [['/compare/', '提交增量对比'], [`/commits/${OWN}?`, '自身写回范围证明']]) {
  test(`${stage}预算耗尽不能再启动回退请求`, async () => {
    const f = remoteFixture();
    let clock = 0;
    const calls = [];
    const next = await f.run({
      now: () => clock,
      request: async (url, opts) => {
        calls.push(url);
        if (url.includes(target)) {
          clock = 120000;
          throw Object.assign(new Error('fixture timeout'), { code: 'GH_TIMEOUT' });
        }
        return f.request(url, opts);
      },
    });
    assert.equal(next.budgetExhausted, true);
    assert.equal(next.timeoutStage, stage);
    assert.equal(classify(next).unknown, true);
    assert.equal(calls.filter((url) => url.includes(target)).length, 1);
    assert.equal(calls.some((url) => url.includes('/commits?') || url.includes('/git/')), false);
  });
}

for (const stage of ['分支/PR/issue 列表', '自身写回范围证明']) {
  test(`${stage}同步整理结果越过预算，也不能返回完整快照`, async () => {
    let clock = 0;
    const expire = (value) => { clock = 120001; return value; };
    const f = stage === '分支/PR/issue 列表'
      ? remoteFixture({ head: BASE, pulls: () => [{ ...remotePull(), get body() { return expire('fixture body'); } }] })
      : remoteFixture({ files: () => ({
        sha: OWN, parents: [{ sha: BASE }],
        files: [{ get filename() { return expire('.pm/demo/manifest.json'); } }],
      }) });
    const next = await f.run({ now: () => clock });
    assert.equal(next.budgetExhausted, true);
    assert.equal(next.timeoutStage, stage);
    assert.equal(next.snapshotComplete, false);
    assert.equal(next.commitsComplete, false);
    assert.equal(classify(next).unknown, true);
  });
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function cancellationFixture() {
  const ready = deferred();
  const calls = [];
  const active = new Set();
  const aborted = [];
  const request = async (url, opts) => {
    const { signal } = opts;
    const label = requestLabel(url, opts);
    calls.push(label);
    if (url === 'repos/fixture/never-contact') return { pushed_at: '2026-11-20T11:00:00Z', default_branch: 'main' };
    assert.ok(signal instanceof AbortSignal, '请求必须收到本轮取消信号');
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
      if (active.size === 3) ready.resolve();
    });
  };
  return { ready, calls, active, aborted, request };
}

test('总预算计时器主动取消全部并发请求，收拢后才返回未知', { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = cancellationFixture();
  let settled = false;
  const running = probeRemote({ id: 'demo', repo: 'fixture/never-contact' }, { request: f.request });
  running.then(() => { settled = true; }, () => { settled = true; });
  await Promise.race([f.ready.promise, running]);
  assert.equal(f.active.size, 3);
  t.mock.timers.tick(119999);
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal(f.aborted.length, 3);
  assert.equal(settled, false, '取消发出后仍需等待请求清理');
  const next = await running;
  assert.equal(next.budgetExhausted, true);
  assert.equal(next.timeoutStage, '分支/PR/issue 列表');
  assert.equal(classify(next).unknown, true);
  assert.equal(f.active.size, 0);
  t.mock.timers.tick(120000);
  assert.equal(f.calls.length, 4, '返回后不能继续分页或重试');
});

test('一个列表重试失败时取消其他列表，清理完毕后保留原始错误', { timeout: 3000 }, async () => {
  const f = cancellationFixture();
  const error = new Error('fixture list failure');
  let failures = 0;
  await assert.rejects(probeRemote({ id: 'demo', repo: 'fixture/never-contact' }, {
    sleep: async () => {},
    request: (url, opts) => {
      if (requestLabel(url, opts).includes('/issues?')) { failures++; throw error; }
      return f.request(url, opts);
    },
  }), (err) => err === error);
  assert.equal(failures, 2);
  assert.equal(f.aborted.length, 2);
  assert.equal(f.active.size, 0);
});

test('默认退避等待与总预算同时到期时，取消优先且不重试', { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  const running = probeRemote({ id: 'demo', repo: 'fixture/never-contact' }, {
    request: async () => {
      calls++;
      t.mock.timers.setTime(119000);
      throw new Error('fixture slow failure');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  const next = await running;
  assert.equal(next.budgetExhausted, true);
  assert.equal(next.timeoutStage, '仓库元数据');
  t.mock.timers.tick(120000);
  assert.equal(calls, 1);
});

test('预算耗尽取消重试等待，不再启动下一次请求', { timeout: 3000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const waiting = deferred();
  let calls = 0;
  let stopped = false;
  const running = probeRemote({ id: 'demo', repo: 'fixture/never-contact' }, {
    request: async () => { calls++; throw new Error('fixture retry'); },
    sleep: async (ms, { signal } = {}) => {
      assert.ok(signal instanceof AbortSignal);
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }, { once: true });
        waiting.resolve();
      });
    },
  });
  await Promise.race([waiting.promise, running]);
  t.mock.timers.tick(120000);
  const next = await running;
  assert.equal(next.budgetExhausted, true);
  assert.equal(next.timeoutStage, '仓库元数据');
  assert.equal(stopped, true);
  assert.equal(calls, 1);
});
