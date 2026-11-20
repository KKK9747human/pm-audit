import { execFileSync } from 'node:child_process';

const cache = new Map();

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function detectIdentity(project) {
  const key = `${project.id}:${project.localRepo || ''}`;
  if (cache.has(key)) return cache.get(key);

  const login = run('gh', ['api', 'user', '--jq', '.login']);
  const email =
    (project.localRepo && run('git', ['-C', project.localRepo, 'config', 'user.email'])) ||
    run('git', ['config', 'user.email']);

  let memberId = null;
  const members = project.members || {};
  if (login) {
    for (const [id, m] of Object.entries(members)) {
      if (m.github && m.github.toLowerCase() === login.toLowerCase()) {
        memberId = id;
        break;
      }
    }
  }
  if (!memberId && email) {
    const local = email.split('@')[0].toLowerCase();
    for (const [id, m] of Object.entries(members)) {
      if (m.github && m.github.toLowerCase() === local) {
        memberId = id;
        break;
      }
    }
  }

  const identity = {
    login: login || null,
    email: email || null,
    memberId,
    memberName: memberId ? members[memberId]?.name || null : null,
    ownedNodes: [],
    checkedAt: new Date().toISOString(),
  };
  cache.set(key, identity);
  return identity;
}

export function clearIdentityCache(project) {
  cache.delete(`${project.id}:${project.localRepo || ''}`);
}

export function identityLabel(identity) {
  if (!identity) return '未知身份';
  const who = identity.login || identity.email || '未登录';
  return identity.memberId ? `${who} → ${identity.memberId}（${identity.memberName}）` : `${who}（未匹配到成员）`;
}

// 管理员 = project.admin + project.admins[] + 所有已绑定 github 的成员。
// 进度数据只落一个数据包，多人可写意味着谁都能发布，所以发布前还会校验远端是否更新。
export function adminList(project) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const login = String(value || '').trim();
    if (!login || seen.has(login.toLowerCase())) return;
    seen.add(login.toLowerCase());
    out.push(login);
  };
  add(project?.admin);
  for (const login of Array.isArray(project?.admins) ? project.admins : []) add(login);
  for (const member of Object.values(project?.members || {})) add(member?.github);
  return out;
}

export function isAdmin(project, identity) {
  const login = String(identity?.login || '').trim().toLowerCase();
  if (!login) return false;
  return adminList(project).some((admin) => admin.toLowerCase() === login);
}

export function adminDenied(project, identity) {
  const who = identity?.login || '未识别身份';
  const admins = adminList(project);
  return `只读模式：项目进度数据只有管理员可以修改（本机 ${who}，管理员 ${admins.join('、') || '未配置'}）`;
}
