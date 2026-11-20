import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderOnboarding } from '../src/onboard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const project = {
  id: 'demo',
  name: '演示',
  repo: 'owner/repo',
  defaultBranch: 'main',
  admin: 'a-user',
  members: { A: { name: '甲', github: 'a-user' } },
};
const bundle = {
  asOf: '2026-11-20T00:00:00.000Z',
  hashes: { facts: 'sha256:abcd1234abcd1234' },
  facts: {
    stats: { nodes: 2, done: 1, active: 0, stale: 0, blocked: 1, ready: 0 },
    criticalPath: { path: ['B1'], len: 3 },
    nodes: [
      { id: 'A1', owner: 'A', state: 'done' },
      { id: 'B1', owner: 'B', state: 'blocked' },
    ],
  },
};

test('接入提示词：占位符全部填上，带仓库/指纹/管理员', () => {
  const text = renderOnboarding(root, project, bundle, { login: 'a-user', memberId: 'A' });
  assert.equal(/\{\{\w+\}\}/.test(text), false);
  assert.match(text, /owner\/repo/);
  assert.match(text, /sha256:abcd1234abcd1234/);
  assert.match(text, /a-user/);
  assert.match(text, /你名下节点：A1/);
  assert.match(text, /pm:node=/);
  assert.match(text, /pm:base=/);
});

test('接入提示词：身份未识别时给绑定指引而不是空名单', () => {
  const text = renderOnboarding(root, project, bundle, null);
  assert.match(text, /身份未识别/);
  assert.equal(/\{\{\w+\}\}/.test(text), false);
});