import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrail, renderTrail } from '../src/trail.mjs';

function fixture() {
  const node = (over) => ({
    id: 'A1',
    title: '节点',
    owner: 'A',
    est: 'M',
    days: 3,
    deps: [],
    blockedBy: [],
    state: 'ready',
    done: false,
    issues: [],
    prs: [],
    branch: null,
    commits: [],
    lastActivity: null,
    daysIdle: null,
    downstream: 0,
    onCriticalPath: false,
    acceptance: '验收一条',
    files: [],
    ...over,
  });
  return {
    format: 'pm-audit/bundle',
    version: 1,
    project: {
      id: 'demo',
      name: '演示',
      repo: 'owner/repo',
      defaultBranch: 'main',
      members: { A: { name: '甲', github: 'a-user' } },
    },
    asOf: '2026-11-20T00:00:00.000Z',
    hashes: { facts: 'sha256:abcd1234abcd1234' },
    plan: { nodes: [] },
    evidence: {
      pulls: [
        {
          number: 7,
          title: '[A1] 完成节点',
          state: 'closed',
          merged_at: '2026-11-19T10:00:00Z',
          head_ref: 'task/A1',
          base_ref: 'main',
          head_sha: '44fdc1df00000000000000000000000000000000',
          additions: 120,
          deletions: 8,
          changed_files: 9,
          commits: 3,
          body: '<!-- pm:node=A1 -->',
        },
      ],
    },
    facts: {
      stats: { nodes: 3, done: 1, active: 1, stale: 0, blocked: 1, ready: 0 },
      nodes: [
        node({ id: 'B1', state: 'blocked', blockedBy: ['A1'], downstream: 2 }),
        node({
          id: 'A2',
          state: 'active',
          branch: 'task/A2',
          commits: [{ sha: 'aaaa1111', date: '2026-11-18T09:00:00Z', message: '[A2] 干活', author: 'a-user' }],
          prs: [{ number: 9, state: 'open', merged_at: null, created_at: '2026-11-18T08:00:00Z', head_ref: 'task/A2', pm_base: null }],
        }),
        node({
          id: 'A1',
          state: 'done',
          done: true,
          acceptance: '9 项 evidence 入库',
          files: ['docs/evidence/nexent-local/', 'docs/评测口径.md'],
          prs: [{ number: 7, state: 'closed', merged_at: '2026-11-19T10:00:00Z', created_at: '2026-11-19T08:00:00Z', head_ref: 'task/A1', pm_base: 'sha256:abcd1234abcd1234' }],
          issues: [{ number: 2, state: 'closed', title: '[A1] 任务卡', updated_at: '2026-11-19T10:00:00Z' }],
        }),
      ],
    },
  };
}

test('证据链：done 排最前，PR 详情从 evidence 补齐', () => {
  const t = buildTrail(fixture());
  assert.equal(t.nodes[0].id, 'A1');
  const a1 = t.nodes[0];
  assert.equal(a1.doneVia, 'merged-pr');
  assert.equal(a1.mergedPr.number, 7);
  assert.equal(a1.mergedPr.title, '[A1] 完成节点');
  assert.equal(a1.mergedPr.additions, 120);
  assert.equal(a1.mergedPr.url, 'https://github.com/owner/repo/pull/7');
  assert.equal(a1.mergedPr.head_sha.slice(0, 8), '44fdc1df');
});

test('证据链：目录用 tree 链接，文件用 blob 链接，提交带链接', () => {
  const t = buildTrail(fixture());
  const a1 = t.nodes.find((n) => n.id === 'A1');
  assert.equal(a1.files[0].url, 'https://github.com/owner/repo/tree/main/docs/evidence/nexent-local');
  assert.equal(a1.files[1].url, 'https://github.com/owner/repo/blob/main/docs/评测口径.md');
  const a2 = t.nodes.find((n) => n.id === 'A2');
  assert.equal(a2.commits[0].url, 'https://github.com/owner/repo/commit/aaaa1111');
});

test('证据链：合并后分支删除要说明，仅关 issue 的完成要标弱证据', () => {
  const b = fixture();
  const t = buildTrail(b);
  assert.match(t.nodes.find((n) => n.id === 'A1').note, /以合并 PR 为准/);
  const a1 = b.facts.nodes.find((n) => n.id === 'A1');
  a1.prs = [];
  const t2 = buildTrail(b);
  const n2 = t2.nodes.find((n) => n.id === 'A1');
  assert.equal(n2.doneVia, 'closed-issue');
  assert.match(n2.note, /证据强度较弱/);
});

test('证据链：diff 统计缺失时用文件清单补，满页截断时不猜', () => {
  const b = fixture();
  delete b.evidence.pulls[0].additions;
  delete b.evidence.pulls[0].deletions;
  delete b.evidence.pulls[0].changed_files;
  b.evidence.pullDetails = {
    7: { files: [{ additions: 10, deletions: 2 }, { additions: 5, deletions: 1 }] },
    9: { files: Array.from({ length: 100 }, () => ({ additions: 1, deletions: 0 })) },
  };
  const t = buildTrail(b);
  const a1 = t.nodes.find((n) => n.id === 'A1');
  assert.equal(a1.mergedPr.additions, 15);
  assert.equal(a1.mergedPr.deletions, 3);
  assert.equal(a1.mergedPr.changed_files, 2);
  const a2 = t.nodes.find((n) => n.id === 'A2');
  assert.equal(a2.prs[0].additions, null);
  assert.equal(a2.prs[0].changed_files, null);
});

test('证据链报告：指纹一致/不一致都要如实写', () => {
  const b = fixture();
  const ok = renderTrail(b, { ok: true, expected: b.hashes.facts, actual: b.hashes.facts });
  assert.match(ok, /重算一致/);
  assert.match(ok, /github\.com\/owner\/repo\/pull\/7/);
  assert.match(ok, /9 项 evidence 入库/);
  assert.match(ok, /tree\/main\/docs\/evidence\/nexent-local/);
  const bad = renderTrail(b, { ok: false, expected: 'sha256:abcd1234', actual: 'sha256:ffff9999' });
  assert.match(bad, /不一致/);
  assert.match(bad, /不要当作可信进度/);
});