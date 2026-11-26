import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeAtomicFile } from './project-lock.mjs';
import { join } from 'node:path';

const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const EST = ['S', 'M', 'L'];
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validatePlan(plan, allowedOwners = null) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('计划必须是 JSON 对象');
  if (!Array.isArray(plan.nodes) || !plan.nodes.length) throw new Error('计划里缺 nodes 数组（至少 1 个节点）');
  const ownerSet = Array.isArray(allowedOwners) || allowedOwners instanceof Set ? new Set(allowedOwners) : null;
  const errors = [];
  if (plan.nodes.length > 40) errors.push(`节点数 ${plan.nodes.length} 超过上限 40`);
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
    if (ownerSet && typeof n.owner === 'string' && n.owner && !ownerSet.has(n.owner)) {
      errors.push(`${at}（${n.id}）owner "${n.owner}" 不在成员表 [${[...ownerSet].join('、')}] 里`);
    }
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
    if (name.startsWith('.')) continue;
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
  writeAtomicFile(metaPath, JSON.stringify(meta, null, 2));
  return meta.members;
}

export function setProjectAdmin(root, id, admin) {
  const p = getProject(root, id);
  const metaPath = join(p.dir, 'project.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  meta.admin = admin || null;
  writeAtomicFile(metaPath, JSON.stringify(meta, null, 2));
  return meta.admin;
}

function cleanIntake(input) {
  if (!input) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('立项记录必须是对象');
  const brief = input.brief && typeof input.brief === 'object' ? input.brief : null;
  if (!brief || typeof brief.idea !== 'string' || !brief.idea.trim()) throw new Error('立项记录缺一句话想法');
  const research = input.research && typeof input.research === 'object' ? input.research : {};
  const markdown = String(input.markdown || '').trim();
  if (!markdown) throw new Error('立项记录缺 research.md 内容');
  if (markdown.length > 20000) throw new Error('立项调研 Markdown 超过 20000 字上限');
  const sources = Array.isArray(input.sources) ? input.sources.map((s) => ({
    id: String(s?.id || '').trim(),
    kind: String(s?.kind || 'source').trim(),
    label: String(s?.label || '').trim(),
  })).filter((s) => s.id && s.label).slice(0, 80) : [];
  return {
    brief,
    research,
    markdown,
    sources,
    provider: String(input.provider || '').slice(0, 80),
    model: String(input.model || '').slice(0, 80),
  };
}

export function createProject(root, { id, name, repo, localRepo, defaultBranch, members, plan, planSource, admin, intake }) {
  if (!PROJECT_ID.test(id || '')) throw new Error('项目 id 只能用小写字母、数字和连字符');
  if (!REPO.test(repo || '')) throw new Error('仓库地址必须是 owner/name 形式');
  validatePlan(plan);
  const clean = cleanIntake(intake);
  const projectsRoot = join(root, 'projects');
  const dir = join(projectsRoot, id);
  if (existsSync(dir)) throw new Error(`项目 ${id} 已存在`);
  const stagingRoot = join(projectsRoot, '.staging');
  mkdirSync(stagingRoot, { recursive: true });
  const staging = join(stagingRoot, `${id}-${randomUUID()}`);
  mkdirSync(staging);
  try {
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
    if (clean) meta.intake = { brief: 'intake.json', research: 'research.md' };
    writeAtomicFile(join(staging, 'project.json'), JSON.stringify(meta, null, 2));
    writeAtomicFile(join(staging, 'plan.json'), JSON.stringify(plan, null, 2));
    if (clean) {
      writeAtomicFile(join(staging, 'research.md'), clean.markdown);
      writeAtomicFile(join(staging, 'intake.json'), JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        ...clean,
      }, null, 2));
    }
    renameSync(staging, dir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return {
    ...JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')),
    dir,
    planPath: join(dir, 'plan.json'),
    plan,
  };
}
