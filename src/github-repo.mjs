import { ghJson } from './gh.mjs';

export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
export const GITHUB_REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,98}[A-Za-z0-9]$|^[A-Za-z0-9]$/;

const error = (message, code) => Object.assign(new Error(message), { code });

export function validateRepoInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('建仓请求必须是对象', 'BAD_REQUEST');
  if (input.confirm !== true) throw error('请先确认要创建的仓库信息', 'CONFIRM_REQUIRED');
  const owner = String(input.owner || '').trim();
  const name = String(input.name || '').trim();
  if (!owner || !GITHUB_OWNER.test(owner)) throw error('GitHub owner 只能包含字母、数字、连字符，且不能以连字符开头或结尾', 'BAD_REQUEST');
  if (!name || !GITHUB_REPO_NAME.test(name)) throw error('仓库名不符合 GitHub 命名规则', 'BAD_REQUEST');
  if (typeof input.private !== 'boolean') throw error('请选择仓库可见性（公开或私有）', 'BAD_REQUEST');
  const description = String(input.description || '').trim().slice(0, 256);
  return { owner, name, private: input.private, description };
}

async function ownerType(owner, client) {
  const user = await client(`users/${encodeURIComponent(owner)}`, { retries: 2 });
  const type = String(user?.type || '').trim();
  if (type !== 'User' && type !== 'Organization') throw error(`无法识别 owner ${owner} 的账号类型`, 'BAD_OWNER');
  return type;
}

async function repoExists(fullName, client) {
  try {
    await client(`repos/${fullName}`, { retries: 2 });
    return true;
  } catch (err) {
    if (/404|not found/i.test(String(err.message))) return false;
    throw err;
  }
}

export async function getGithubAccount({ client = ghJson } = {}) {
  const user = await client('user', { retries: 3 });
  if (!user?.login) throw error('gh 登录状态里没有 login', 'GH_ACCOUNT');
  return { login: user.login, type: user.type === 'Organization' ? 'Organization' : 'User' };
}

export async function createGithubRepo(input, { client = ghJson } = {}) {
  const plan = validateRepoInput(input);
  const type = await ownerType(plan.owner, client);
  const fullName = `${plan.owner}/${plan.name}`;
  if (await repoExists(fullName, client)) throw error(`${fullName} 已存在；不覆盖、不删除`, 'REPO_EXISTS');
  const createPath = type === 'Organization' ? `orgs/${encodeURIComponent(plan.owner)}/repos` : 'user/repos';
  const body = {
    name: plan.name,
    private: plan.private,
    auto_init: true,
    ...(plan.description ? { description: plan.description } : {}),
  };
  const created = await client(createPath, { method: 'POST', body, retries: 3 });
  const htmlUrl = created?.html_url || `https://github.com/${fullName}`;
  let branchWarning = '';
  let defaultBranch = String(created?.default_branch || '');
  if (defaultBranch !== 'main') {
    try {
      const patched = await client(`repos/${fullName}`, { method: 'PATCH', body: { default_branch: 'main' }, retries: 2 });
      defaultBranch = String(patched?.default_branch || 'main');
    } catch (err) {
      branchWarning = '仓库已创建，但默认分支改成 main 失败；请在 GitHub 手动调整。';
    }
  }
  return {
    full_name: created?.full_name || fullName,
    html_url: htmlUrl,
    private: plan.private,
    default_branch: defaultBranch || 'main',
    initialized: true,
    ...(branchWarning ? { warning: branchWarning } : {}),
  };
}
