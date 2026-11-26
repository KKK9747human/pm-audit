import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePlan, createProject, listProjects, getProject, pickProject, setProjectAdmin, setMemberGithub } from '../src/project.mjs';
import { samplePlan } from './lib/fixture.mjs';

test('validatePlan 接受合法计划', () => {
  const r = validatePlan(samplePlan());
  assert.equal(r.nodes, 4);
  assert.deepEqual(r.ids, ['A1', 'A2', 'A3', 'A4']);
});

test('validatePlan 拒绝空 nodes、重复 id、坏 est', () => {
  assert.throws(() => validatePlan({}), /nodes/);
  const dup = samplePlan();
  dup.nodes.push({ id: 'A1', title: '重复' });
  assert.throws(() => validatePlan(dup), /重复/);
  const badEst = samplePlan();
  badEst.nodes[0].est = 'XL';
  assert.throws(() => validatePlan(badEst), /est 只能是 S\/M\/L/);
});

test('validatePlan 拒绝不存在的依赖与自依赖', () => {
  const missing = samplePlan();
  missing.nodes[1].deps = ['NOPE'];
  assert.throws(() => validatePlan(missing), /依赖不存在的 NOPE/);
  const self = samplePlan();
  self.nodes[0].deps = ['A1'];
  assert.throws(() => validatePlan(self), /依赖自己/);
});

test('validatePlan 拒绝依赖环', () => {
  const cyc = {
    nodes: [
      { id: 'A', title: 'a', deps: ['B'] },
      { id: 'B', title: 'b', deps: ['A'] },
    ],
  };
  assert.throws(() => validatePlan(cyc), /有环/);
});

test('createProject 校验 id、repo、计划，并能读回', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-project-'));
  try {
    assert.throws(() => createProject(root, { id: 'Bad Id', repo: 'a/b', plan: samplePlan() }), /项目 id/);
    assert.throws(() => createProject(root, { id: 'ok', repo: 'not-a-repo', plan: samplePlan() }), /owner\/name/);
    assert.throws(() => createProject(root, { id: 'ok', repo: 'a/b', plan: { nodes: [] } }), /nodes/);
    assert.equal(existsSync(join(root, 'projects')), false, '校验失败不应留下项目目录');

    const p = createProject(root, { id: 'demo', repo: 'acme/demo', plan: samplePlan(), admin: 'octo' });
    assert.equal(p.admin, 'octo');
    assert.ok(existsSync(join(p.dir, 'project.json')));
    assert.ok(existsSync(join(p.dir, 'plan.json')));
    assert.equal(listProjects(root).length, 1);
    assert.equal(getProject(root, 'demo').plan.nodes.length, 4);
    assert.throws(() => createProject(root, { id: 'demo', repo: 'acme/demo', plan: samplePlan() }), /已存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pickProject：无项目/单项目/多项目', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-pick-'));
  try {
    assert.throws(() => pickProject(root), /还没有项目/);
    createProject(root, { id: 'one', repo: 'acme/one', plan: samplePlan() });
    assert.equal(pickProject(root).id, 'one');
    createProject(root, { id: 'two', repo: 'acme/two', plan: samplePlan() });
    assert.throws(() => pickProject(root), /多个项目/);
    assert.equal(pickProject(root, 'two').id, 'two');
    assert.throws(() => pickProject(root, 'nope'), /不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('项目配置写入是原子替换且不留临时文件', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pm-project-atomic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createProject(root, { id: 'demo', repo: 'acme/demo', plan: samplePlan(), members: { m1: { name: 'One' } } });
  setProjectAdmin(root, 'demo', 'octo');
  setMemberGithub(root, 'demo', 'm1', 'octocat');
  const tmp = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tmp')) tmp.push(full);
    }
  })(join(root, 'projects'));
  assert.deepEqual(tmp, []);
});

test('管理员与成员映射写回 project.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-admin-'));
  try {
    createProject(root, { id: 'demo', repo: 'acme/demo', plan: samplePlan(), members: { m1: { name: 'One' } } });
    assert.equal(setProjectAdmin(root, 'demo', 'octo'), 'octo');
    assert.equal(getProject(root, 'demo').admin, 'octo');
    const members = setMemberGithub(root, 'demo', 'm1', 'octocat');
    assert.equal(members.m1.github, 'octocat');
    assert.throws(() => setMemberGithub(root, 'demo', 'nope', 'x'), /成员 nope 不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createProject：带立项记录时写四个文件，缺失时不写', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-intake-project-'));
  try {
    const plain = createProject(root, { id: 'plain', repo: 'acme/plain', plan: samplePlan() });
    assert.ok(existsSync(join(plain.dir, 'project.json')));
    assert.ok(existsSync(join(plain.dir, 'plan.json')));
    assert.equal(existsSync(join(plain.dir, 'intake.json')), false);
    assert.equal(existsSync(join(plain.dir, 'research.md')), false);

    const intake = createProject(root, {
      id: 'guided',
      repo: 'acme/guided',
      plan: samplePlan(),
      intake: {
        brief: { idea: '做一个立项向导' },
        research: { summary: '一句话', facts: [], assumptions: [], unknowns: [], risks: [] },
        markdown: '# 立项调研\n事实：X（DOC-1）',
        sources: [{ id: 'DOC-1', kind: 'doc', label: 'README.md' }],
        provider: 'mock',
        model: 'fixture',
      },
    });
    assert.deepEqual(intake.intake, { brief: 'intake.json', research: 'research.md' });
    assert.match(readFileSync(join(intake.dir, 'research.md'), 'utf8'), /事实：X/);
    const record = JSON.parse(readFileSync(join(intake.dir, 'intake.json'), 'utf8'));
    assert.equal(record.version, 1);
    assert.equal(record.brief.idea, '做一个立项向导');
    assert.equal(record.provider, 'mock');
    assert.doesNotMatch(JSON.stringify(record), /key|token|Authorization/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createProject：写入失败只清掉 staging，不留半个项目', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-staging-fail-'));
  try {
    const badPlan = samplePlan();
    badPlan.bad = { toJSON: () => { throw new Error('模拟序列化失败'); } };
    assert.throws(() => createProject(root, { id: 'fail', repo: 'acme/fail', plan: badPlan }), /模拟序列化失败/);
    assert.equal(existsSync(join(root, 'projects', 'fail')), false);
    const staging = join(root, 'projects', '.staging');
    assert.equal(existsSync(staging) ? readdirSync(staging).length : 0, 0);
    assert.equal(listProjects(root).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listProjects 忽略 .staging', () => {
  const root = mkdtempSync(join(tmpdir(), 'pm-staging-list-'));
  try {
    createProject(root, { id: 'demo', repo: 'acme/demo', plan: samplePlan() });
    mkdirSync(join(root, 'projects', '.staging', 'junk'), { recursive: true });
    writeFileSync(join(root, 'projects', '.staging', 'junk', 'project.json'), '{}');
    assert.deepEqual(listProjects(root).map((p) => p.id), ['demo']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('validatePlan owner 必须在成员表里', () => {
  const plan = samplePlan();
  assert.doesNotThrow(() => validatePlan(plan, ['m1', 'm2']));
  assert.throws(() => validatePlan(plan, ['m1']), /owner "m2" 不在成员表/);
  assert.throws(() => validatePlan(plan, []), /owner "m1" 不在成员表/);
});

test('validatePlan 拒绝超过 40 个节点', () => {
  const plan = { nodes: Array.from({ length: 41 }, (_, i) => ({ id: `N${i + 1}`, title: `节点 ${i + 1}` })) };
  assert.throws(() => validatePlan(plan), /超过上限 40/);
  plan.nodes.pop();
  assert.equal(validatePlan(plan).nodes, 40);
});
