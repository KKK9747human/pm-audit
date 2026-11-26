import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRepoInput, getGithubAccount, createGithubRepo } from '../src/github-repo.mjs';

test('validateRepoInput：必须显式确认且输入合法', () => {
  assert.throws(() => validateRepoInput({ owner: 'alice', name: 'demo', private: true }), /确认/);
  assert.throws(() => validateRepoInput({ owner: '-bad', name: 'demo', private: true, confirm: true }), /owner/);
  assert.throws(() => validateRepoInput({ owner: 'alice', name: '.bad', private: true, confirm: true }), /仓库名/);
  assert.deepEqual(
    validateRepoInput({ owner: 'alice', name: 'demo', private: true, description: ' d ', confirm: true }),
    { owner: 'alice', name: 'demo', private: true, description: 'd' },
  );
});

test('getGithubAccount：只返回 login/type', async () => {
  const r = await getGithubAccount({ client: async () => ({ login: 'alice', type: 'User' }) });
  assert.deepEqual(r, { login: 'alice', type: 'User' });
});

test('createGithubRepo：个人仓库走 user/repos，并修正 main 分支', async () => {
  const calls = [];
  const client = async (path, opts = {}) => {
    calls.push([path, opts]);
    if (path === 'user') return { login: 'alice', type: 'User' };
    if (path === 'users/alice') return { type: 'User' };
    if (path === 'repos/alice/demo' && !opts.method) throw new Error('404 Not Found');
    if (opts.method === 'POST') return { full_name: 'alice/demo', html_url: 'https://github.com/alice/demo', default_branch: 'master' };
    if (opts.method === 'PATCH') return { default_branch: 'main' };
    throw new Error(`unexpected ${path}`);
  };
  const r = await createGithubRepo({ owner: 'alice', name: 'demo', private: true, confirm: true }, { client });
  assert.equal(r.full_name, 'alice/demo');
  assert.equal(r.default_branch, 'main');
  assert.equal(calls.some(([p, o]) => p === 'user/repos' && o.method === 'POST'), true);
  assert.equal(calls.some(([p, o]) => p === 'repos/alice/demo' && o.method === 'PATCH'), true);
});

test('createGithubRepo：组织仓库走 orgs 路径；已存在不覆盖', async () => {
  const calls = [];
  const client = async (path, opts = {}) => {
    calls.push([path, opts]);
    if (path === 'users/acme') return { type: 'Organization' };
    if (path === 'repos/acme/app' && !opts.method) return { full_name: 'acme/app' };
    throw new Error('404 Not Found');
  };
  await assert.rejects(
    () => createGithubRepo({ owner: 'acme', name: 'app', private: false, confirm: true }, { client }),
    /已存在/,
  );
  assert.equal(calls.some(([, o]) => o.method === 'POST'), false);
});

test('createGithubRepo：默认分支修正失败时保留警告，不谎报完成', async () => {
  const client = async (path, opts = {}) => {
    if (path === 'users/alice') return { type: 'User' };
    if (path === 'repos/alice/demo' && !opts.method) throw new Error('404 Not Found');
    if (opts.method === 'POST') return { full_name: 'alice/demo', html_url: 'u', default_branch: 'master' };
    if (opts.method === 'PATCH') throw new Error('branch protected');
    throw new Error(path);
  };
  const r = await createGithubRepo({ owner: 'alice', name: 'demo', private: true, confirm: true }, { client });
  assert.match(r.warning, /默认分支改成 main 失败/);
});
