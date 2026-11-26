import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgent, writeAgentLocal } from '../src/agent.mjs';
import { buildBundle } from '../src/bundle.mjs';
import { buildFacts } from '../src/facts.mjs';
import { samplePlan, sampleProject, sampleRaw } from './lib/fixture.mjs';

function fixture() {
  const project = sampleProject();
  const raw = sampleRaw();
  const facts = buildFacts(samplePlan(), raw, project, raw.fetchedAt);
  return { project, bundle: buildBundle(project, raw, facts) };
}

test('单节点简报包含验收、证据、停止条件、报告格式和 pm:base 语义', () => {
  const { project, bundle } = fixture();
  const agent = buildAgent(project, bundle, { login: 'one', memberId: 'm1' });
  const md = agent.nodeMarkdown('A2');
  assert.match(md, /验收标准/);
  assert.match(md, /依赖：A1/);
  assert.match(md, /PR #2/);
  assert.match(md, /pm:node=A2/);
  assert.match(md, /pm:base=sha256:[0-9a-f]{64}/);
  assert.match(md, /停止条件/);
  assert.match(md, /需要修改计划、降低验收标准或扩大权限/);
  assert.match(md, /完成后报告格式/);
  assert.match(md, /pm:base.*落后是可能的/);
  assert.ok(md.includes(project.repo), 'standalone handoff must name the target repository');
  assert.ok(md.includes(`默认分支：${project.defaultBranch}`));
  assert.match(md, /目标代码仓库/);
  assert.match(md, /不代表.*认领|不是.*锁/);
});

test('生成 Agent 简报不改变状态，也不冒充认领', () => {
  const { project, bundle } = fixture();
  const before = JSON.stringify(bundle.facts.nodes.map((n) => [n.id, n.state, n.owner]));
  const agent = buildAgent(project, bundle, { login: 'one', memberId: 'm1' });
  const after = JSON.stringify(bundle.facts.nodes.map((n) => [n.id, n.state, n.owner]));
  assert.equal(after, before);
  assert.equal(agent.index.nodes.find((n) => n.id === 'A2').state, 'active');
  assert.doesNotMatch(agent.nodeMarkdown('A2'), /已认领|已锁定|claim/i);
});

test('阻塞节点先报告等谁，不要求绕开依赖', () => {
  const { project, bundle } = fixture();
  const agent = buildAgent(project, bundle, null);
  const md = agent.nodeMarkdown('A3');
  assert.match(md, /先等 A2/);
  assert.match(md, /不要动本节点/);
});

test('writeAgentLocal 逐文件原子替换并清理失效任务文件', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pm-agent-write-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { project, bundle } = fixture();
  const dir = join(root, 'data', project.id, 'agent');
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(join(dir, 'index.json'), '{"old":true}\n', 'utf8');
  writeFileSync(join(dir, 'AGENT.md'), 'old guide', 'utf8');
  writeFileSync(join(dir, 'tasks', 'A1.md'), 'old task', 'utf8');
  writeFileSync(join(dir, 'tasks', 'obsolete.md'), 'stale', 'utf8');

  const agent = writeAgentLocal(root, project, bundle, { login: 'one', memberId: 'm1' });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')), JSON.parse(JSON.stringify(agent.index)));
  assert.equal(readFileSync(join(dir, 'AGENT.md'), 'utf8'), agent.guide);
  assert.equal(readFileSync(join(dir, 'tasks', 'A1.md'), 'utf8'), agent.nodeMarkdown('A1'));
  assert.equal(existsSync(join(dir, 'tasks', 'obsolete.md')), false);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  assert.deepEqual(readdirSync(join(dir, 'tasks')).filter((name) => name.endsWith('.tmp')), []);
});

test('任务文件写入失败时保留旧 index/AGENT，不删旧简报', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pm-agent-write-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { project, bundle } = fixture();
  const dir = join(root, 'data', project.id, 'agent');
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(join(dir, 'index.json'), '{"old":true}\n', 'utf8');
  writeFileSync(join(dir, 'AGENT.md'), 'old guide', 'utf8');
  // 让 A2 的原子替换必然失败：目标位置被目录占用。
  mkdirSync(join(dir, 'tasks', 'A2.md'), { recursive: true });

  assert.throws(() => writeAgentLocal(root, project, bundle, { login: 'one', memberId: 'm1' }));
  assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), '{"old":true}\n', 'index 必须仍是旧版');
  assert.equal(readFileSync(join(dir, 'AGENT.md'), 'utf8'), 'old guide', 'AGENT.md 必须仍是旧版');
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  assert.deepEqual(readdirSync(join(dir, 'tasks')).filter((name) => name.endsWith('.tmp')), []);
});
