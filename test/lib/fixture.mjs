export function samplePlan() {
  return {
    project: 'Demo',
    nodes: [
      { id: 'A1', title: '基础接入', owner: 'm1', est: 'S', deps: [], files: ['a.js'], acceptance: '能跑' },
      { id: 'A2', title: '主链路', owner: 'm1', est: 'M', deps: ['A1'] },
      { id: 'A3', title: '收尾验收', owner: 'm2', est: 'L', deps: ['A2'] },
      { id: 'A4', title: '独立支线', owner: 'm2', est: 'S', deps: [] },
    ],
  };
}

export function sampleProject(overrides = {}) {
  return {
    id: 'demo',
    name: 'Demo',
    repo: 'acme/demo',
    defaultBranch: 'main',
    admin: 'Octo',
    members: { m1: { name: 'One', github: 'one' }, m2: { name: 'Two', github: 'two' } },
    planSource: '',
    plan: samplePlan(),
    commitWindowDays: 30,
    staleDays: 5,
    activeWindowDays: 14,
    maxBranchesToScan: 8,
    ...overrides,
  };
}

export function sampleRaw() {
  return {
    repo: { full_name: 'acme/demo', pushed_at: '2026-01-10T00:00:00Z' },
    fetchedAt: '2026-01-10T00:00:00Z',
    issues: [],
    pulls: [
      {
        number: 1,
        state: 'closed',
        merged_at: '2026-01-02T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        head_ref: 'task/A1',
        base_ref: 'main',
        title: '[A1] 基础接入',
        body: '<!-- pm:node=A1 -->',
      },
      {
        number: 2,
        state: 'open',
        merged_at: null,
        updated_at: '2026-01-09T00:00:00Z',
        created_at: '2026-01-08T00:00:00Z',
        head_ref: 'task/A2',
        base_ref: 'main',
        title: '[A2] 主链路',
        body: '<!-- pm:node=A2 -->\n<!-- pm:base=sha256:abc -->',
      },
    ],
    branches: [{ name: 'main' }, { name: 'task/A1' }, { name: 'task/A2' }, { name: 'feature/x' }],
    branchCommits: [
      { name: 'main', commits: [{ sha: 'c1', message: 'init', date: '2026-01-01T00:00:00Z' }] },
      { name: 'task/A1', commits: [{ sha: 'c0', message: '[A1] 基础接入', date: '2026-01-02T00:00:00Z' }] },
      {
        name: 'task/A2',
        commits: [
          { sha: 'c1', message: 'init', date: '2026-01-01T00:00:00Z' },
          { sha: 'c2', message: 'A2 主链路实现', date: '2026-01-08T00:00:00Z' },
        ],
      },
      { name: 'feature/x', commits: [{ sha: 'c3', message: '[A2] 补测', date: '2026-01-09T00:00:00Z' }] },
    ],
    pullDetails: { 2: { aheadShas: ['c2'] } },
  };
}
