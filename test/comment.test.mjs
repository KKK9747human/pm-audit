import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProgressNote } from '../src/comment.mjs';
import { buildFacts } from '../src/facts.mjs';
import { buildBundle } from '../src/bundle.mjs';
import { samplePlan, sampleProject, sampleRaw } from './lib/fixture.mjs';

function fixtureBundle() {
  const project = sampleProject();
  const raw = sampleRaw();
  return buildBundle(project, raw, buildFacts(samplePlan(), raw, project, raw.fetchedAt));
}

test('进度备注包含统计、关键路径与卡点', () => {
  const note = buildProgressNote(sampleProject(), fixtureBundle());
  assert.match(note, /\[PM\] 进度备注/);
  assert.match(note, /节点：4 个/);
  assert.match(note, /关键路径：A2→A3（11 人日）/);
  assert.match(note, /当前卡点/);
  assert.match(note, /A3/);
  assert.match(note, /只读不改代码/);
});
