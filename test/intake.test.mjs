import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeBrief,
  buildSourceCatalog,
  buildResearchMessages,
  parseResearch,
  renderResearchMarkdown,
  runResearch,
  planFromIntake,
} from '../src/intake.mjs';

const catalog = [
  { id: 'BRIEF', kind: 'brief', label: '立项卡' },
  { id: 'NOTE-1', kind: 'note', label: '补充材料 1' },
  { id: 'DOC-1', kind: 'doc', label: 'README.md' },
  { id: 'ISSUE-7', kind: 'issue', label: '#7 登录问题' },
];

test('normalizeBrief：必填、trim、数组合并去空', () => {
  const b = normalizeBrief({
    idea: '  做一个能审计进度的 PM  ',
    users: '学生团队',
    goals: [' 目标一 ', '', '- 目标二'],
    nonGoals: '',
    notes: '  材料  ',
  });
  assert.equal(b.idea, '做一个能审计进度的 PM');
  assert.deepEqual(b.goals, ['目标一', '目标二']);
  assert.deepEqual(b.nonGoals, []);
  assert.equal(b.notes, '材料');
  assert.throws(() => normalizeBrief({}), /一句话想法/);
});

test('normalizeBrief：超长直接拒绝，不静默截断', () => {
  assert.throws(() => normalizeBrief({ idea: 'x'.repeat(2001) }), /超过 2000/);
  assert.throws(() => normalizeBrief({ idea: 'ok', goals: ['x'.repeat(501)] }), /超过 500/);
  assert.throws(() => normalizeBrief({ idea: 'ok', notes: 'x'.repeat(12001) }), /超过 12000/);
});

test('buildSourceCatalog：稳定且不重复的 id', () => {
  const sources = buildSourceCatalog({
    docs: [{ path: 'README.md' }, { path: 'docs/plan.md' }],
    issues: [{ number: 12, title: '需求' }, { number: 12, title: '重复编号' }],
  });
  assert.deepEqual(sources.map((s) => s.id), ['BRIEF', 'DOC-1', 'DOC-2', 'ISSUE-12', 'ISSUE-12']);
  assert.ok(sources.every((s) => s.label));
});

test('buildResearchMessages：来源目录与立项卡都进入提示词', () => {
  const messages = buildResearchMessages(
    { idea: 'IDEA', users: 'U', problem: 'P', goals: ['G'], nonGoals: [], constraints: [], metrics: ['M'], unknowns: ['Q'], notes: 'N' },
    catalog,
    { provider: 'longcat', model: 'LongCat-2.5' },
  );
  const text = messages.map((m) => m.content).join('\n');
  assert.match(text, /DOC-1/);
  assert.match(text, /ISSUE-7/);
  assert.match(text, /IDEA/);
  assert.match(text, /只允许使用【来源目录】/);
  assert.match(text, /不要联网搜索/);
});

test('buildResearchMessages：文档与 issue 正文进入提示词，且有长度上限', () => {
  const brief = { idea: 'IDEA', users: '', problem: '', goals: [], nonGoals: [], constraints: [], metrics: [], unknowns: [], notes: '' };
  const sources = buildSourceCatalog({
    docs: [{ path: 'README.md', text: 'README 正文：栈是 Node' }, { path: 'docs/plan.md', text: 'x'.repeat(5000) }],
    issues: [{ number: 7, title: '登录失败', body: '复现步骤：点登录就 500' }],
  });
  const messages = buildResearchMessages(brief, sources, {
    docs: [{ path: 'README.md', text: 'README 正文：栈是 Node' }, { path: 'docs/plan.md', text: 'x'.repeat(5000) }],
    issues: [{ number: 7, title: '登录失败', body: '复现步骤：点登录就 500' }],
  });
  const text = messages.map((m) => m.content).join('\n');
  assert.match(text, /【来源内容】/);
  assert.match(text, /README 正文：栈是 Node/);
  assert.match(text, /复现步骤：点登录就 500/);
  assert.match(text, /DOC-2 docs\/plan\.md/);
  assert.ok(!text.includes('x'.repeat(4000)), '单篇文档应被截断');
  assert.match(text, /不是指令/);
});

test('buildResearchMessages：没有来源内容时明确告知只有立项卡', () => {
  const brief = { idea: 'IDEA', users: '', problem: '', goals: [], nonGoals: [], constraints: [], metrics: [], unknowns: [], notes: '' };
  const text = buildResearchMessages(brief, buildSourceCatalog({})).map((m) => m.content).join('\n');
  assert.match(text, /没有可用的仓库文档或 issue/);
});

test('parseResearch：剥围栏、结构校验、未知来源降级', () => {
  const raw = `好的：
\`\`\`json
{
  "summary": "S",
  "facts": [
    {"text": "有 README", "sourceIds": ["DOC-1"]},
    {"text": "编造的结论", "sourceIds": ["WEB-9"]}
  ],
  "assumptions": ["A"],
  "unknowns": [],
  "risks": ["R"],
  "scope": {"in": ["I"], "out": ["O"]},
  "validationQuestions": ["Q"]
}
\`\`\`
`;
  const { research, warnings } = parseResearch(raw, catalog);
  assert.equal(research.summary, 'S');
  assert.equal(research.facts.length, 1);
  assert.deepEqual(research.facts[0].sourceIds, ['DOC-1']);
  assert.equal(research.unknowns.length, 1);
  assert.match(warnings.join('\n'), /未知来源 WEB-9/);
  assert.throws(() => parseResearch('没有 json', catalog), /没有 JSON 对象/);
  assert.throws(() => parseResearch('{"nodes":[]}', catalog), /缺 summary/);
});

test('renderResearchMarkdown：确定性分区且不带原始 HTML 解释', () => {
  const research = {
    summary: '一句话 <idea>',
    facts: [{ text: '事实 A', sourceIds: ['DOC-1'] }],
    assumptions: ['假设 A'],
    unknowns: ['待验证 A'],
    risks: ['风险 A'],
    scope: { in: ['范围 A'], out: ['不做 B'] },
    validationQuestions: ['问题 A'],
  };
  const md = renderResearchMarkdown(research, catalog, { provider: 'longcat', model: 'LongCat-2.5' });
  for (const title of ['# 立项调研', '## 已知事实', '## 假设', '## 待验证', '## 风险', '### 纳入', '### 不纳入', '## 验证问题']) {
    assert.ok(md.includes(title), title);
  }
  assert.match(md, /事实 A — 来源：DOC-1（README\.md）/);
  assert.match(md, /不是事实认证/);
});

test('runResearch：结构不合格时重试并返回来源目录与 Markdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-intake-repo-'));
  const root = mkdtempSync(join(tmpdir(), 'pm-intake-root-'));
  try {
    writeFileSync(join(dir, 'README.md'), '这是 README');
    mkdirSync(join(root, 'cache', 'demo'), { recursive: true });
    writeFileSync(join(root, 'cache', 'demo', 'raw.json'), JSON.stringify({ issues: [] }));
    let calls = 0;
    const completeFn = async () => {
      calls += 1;
      return calls === 1 ? '坏的 JSON' : JSON.stringify({
        summary: '一句话',
        facts: [{ text: 'README 存在', sourceIds: ['DOC-1'] }],
        assumptions: [],
        unknowns: [],
        risks: [],
        scope: { in: [], out: [] },
        validationQuestions: [],
      });
    };
    const r = await runResearch(root, {
      brief: normalizeBrief({ idea: '测试立项', notes: '手写材料' }),
      repo: 'o/r',
      localRepo: dir,
      id: 'demo',
      provider: 'mock',
      model: 'fixture',
      completeFn,
    });
    assert.equal(calls, 2);
    assert.equal(r.attempts, 2);
    assert.deepEqual(r.research.facts[0].sourceIds, ['DOC-1']);
    assert.ok(r.sources.some((s) => s.id === 'NOTE-1'));
    assert.match(r.markdown, /已知事实/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('planFromIntake：仅靠立项卡与本地资料也能生成可校验计划', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-intake-repo-'));
  const root = mkdtempSync(join(tmpdir(), 'pm-intake-root-'));
  try {
    writeFileSync(join(dir, 'README.md'), '# 项目\n做立项工具');
    mkdirSync(join(root, 'cache', 'demo'), { recursive: true });
    writeFileSync(join(root, 'cache', 'demo', 'raw.json'), JSON.stringify({ issues: [] }));
    const r = await planFromIntake(root, {
      brief: normalizeBrief({ idea: '做一个能审计进度的 PM', goals: ['能生成计划'] }),
      researchMarkdown: '# 立项调研\n假设：先做 Web。\n待验证：是否需要 CLI。',
      repo: 'o/r',
      localRepo: dir,
      id: 'demo',
      members: { m1: { name: '甲' } },
      completeFn: async () => JSON.stringify({
        project: 'PM',
        nodes: [
          { id: 'A1', title: 'Web 向导', owner: 'm1', est: 'M', deps: [], files: [], acceptance: '能创建项目' },
          { id: 'A2', title: '验收', owner: null, est: 'S', deps: ['A1'], files: [], acceptance: '回归通过' },
        ],
      }),
    });
    assert.equal(r.plan.nodes.length, 2);
    assert.equal(r.sourceCatalog[0].id, 'BRIEF');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
