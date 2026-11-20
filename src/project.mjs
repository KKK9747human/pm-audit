import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const EST = ['S', 'M', 'L'];
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('计划必须是 JSON 对象');
  if (!Array.isArray(plan.nodes) || !plan.nodes.length) throw new Error('计划里缺 nodes 数组（至少 1 个节点）');
  const errors = [];
  const ids = new Set();
  plan.nodes.forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      errors.push(`${at} 不是对象`);
      return;
    }
    if (!n.id) errors.push(`${at} 缺 id`);
    else if (typeof n.id !== 'string' || !NODE_ID.test(n.id)) {
      errors.push(`${at} id "${n.id}" 只能用字母、数字、- 和 _，且以字母或数字开头`);
    } else if (ids.has(n.id)) errors.push(`${at} id "${n.id}" 重复`);
    else ids.add(n.id);
    if (typeof n.title !== 'string' || !n.title.trim()) errors.push(`${at}（${n.id || '?'}）缺 title`);
    if (n.est !== undefined && !EST.includes(n.est)) errors.push(`${at}（${n.id}）est 只能是 S/M/L`);
    if (n.deps !== undefined && !Array.isArray(n.deps)) errors.push(`${at}（${n.id}）deps 必须是数组`);
    if (n.files !== undefined && !Array.isArray(n.files)) errors.push(`${at}（${n.id}）files 必须是数组`);
    if (n.owner !== undefined && typeof n.owner !== 'string') errors.push(`${at}（${n.id}）owner 必须是字符串`);
  });
  const byId = new Map();
  for (const n of plan.nodes) {
    if (n && n.id && ids.has(n.id) && !byId.has(n.id)) byId.set(n.id, n);
  }
  for (const n of byId.values()) {
    for (const d of n.deps || []) {
      if (d === n.id) errors.push(`节点 ${n.id} 依赖自己`);
      else if (!byId.has(d)) errors.push(`节点 ${n.id} 依赖不存在的 ${d}`);
    }
  }
  const mark = new Map();
  const visit = (id, trail) => {
    if (mark.get(id) === 2) return;
    if (mark.get(id) === 1) {
      errors.push(`依赖有环：${[...trail, id].join(' → ')}`);
      return;
    }
    mark.set(id, 1);
    for (const d of byId.get(id)?.deps || []) if (byId.has(d)) visit(d, [...trail, id]);
    mark.set(id, 2);
  };
  for (const id of byId.keys()) visit(id, []);
  if (errors.length) {
    const err = new Error(`计划校验失败：\n- ${errors.join('\n- ')}`);
    err.code = 'INVALID_PLAN';
    err.details = errors;
    throw err;
  }
  return { nodes: plan.nodes.length, ids: [...ids] };
}

export function listProjects(root) {
  const dir = join(root, 'projects');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const metaPath = join(dir, name, 'project.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      const id = meta.id || name;
      const planRel = meta.plan || 'plan.json';
      const planPath = join(dir, name, planRel);
      const plan = JSON.parse(readFileSync(planPath, 'utf8'));
      out.push({ ...meta, id, dir: join(dir, name), planPath, plan });
    } catch (err) {
      console.error(`[project] ${name} 读取失败: ${err.message}`);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function getProject(root, id) {
  const p = listProjects(root).find((x) => x.id === id);
  if (!p) {
    const all = listProjects(root).map((x) => x.id);
    throw new Error(
      `项目 ${id} 不存在` + (all.length ? `（本机有：${all.join('、')}）` : '（本机还没有项目，用 project:add 或 adopt 添加）'),
    );
  }
  return p;
}

export function pickProject(root, id) {
  const all = listProjects(root);
  if (id) {
    const p = all.find((x) => x.id === id);
    if (!p) throw new Error(`项目 ${id} 不存在（本机有：${all.map((x) => x.id).join('、') || '无'}）`);
    return p;
  }
  if (!all.length) throw new Error('本机还没有项目，用 project:add 或 adopt 添加');
  if (all.length === 1) return all[0];
  throw new Error(`本机有多个项目，请指定 id：${all.map((x) => x.id).join(' ')}`);
}

export function setMemberGithub(root, id, memberId, github) {
  const p = getProject(root, id);
  const metaPath = join(p.dir, 'project.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (!meta.members?.[memberId]) throw new Error(`成员 ${memberId} 不存在`);
  meta.members[memberId].github = github || null;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return meta.members;
}

export function setProjectAdmin(root, id, admin) {
  const p = getProject(root, id);
  const metaPath = join(p.dir, 'project.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  meta.admin = admin || null;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  return meta.admin;
}

export function createProject(root, { id, name, repo, localRepo, defaultBranch, members, plan, planSource, admin }) {
  if (!PROJECT_ID.test(id || '')) throw new Error('项目 id 只能用小写字母、数字和连字符');
  if (!REPO.test(repo || '')) throw new Error('仓库地址必须是 owner/name 形式');
  validatePlan(plan);
  const dir = join(root, 'projects', id);
  if (existsSync(dir)) throw new Error(`项目 ${id} 已存在`);
  mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    name: name || id,
    repo,
    localRepo: localRepo || null,
    defaultBranch: defaultBranch || 'main',
    admin: admin || null,
    members: members || {},
    staleDays: 5,
    activeWindowDays: 14,
    commitWindowDays: 30,
    maxBranchesToScan: 8,
    plan: 'plan.json',
    planSource: planSource || '',
  };
  writeFileSync(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  return { ...meta, dir, planPath: join(dir, 'plan.json'), plan };
}
