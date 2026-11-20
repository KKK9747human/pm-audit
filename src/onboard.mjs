import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminList } from './identity.mjs';

export function renderOnboarding(root, project, bundle, identity) {
  const tpl = readFileSync(join(root, 'templates', 'agent-onboarding.md'), 'utf8');
  const f = bundle.facts;
  const owned = identity?.memberId
    ? f.nodes.filter((n) => n.owner === identity.memberId).map((n) => n.id).join('、') || '无（身份未匹配到成员，先在工作台绑定）'
    : '身份未识别：先在工作台绑定成员，或按 AGENT.md 的顺序选 ready 节点';
  const map = {
    PROJECT_NAME: project.name,
    PROJECT_ID: project.id,
    REPO: project.repo,
    BRANCH: project.defaultBranch || 'main',
    ASOF: bundle.asOf,
    HASH: bundle.hashes.facts,
    STATS: `${f.stats.nodes} 节点：完成 ${f.stats.done}｜进行中 ${f.stats.active}｜停滞 ${f.stats.stale}｜阻塞 ${f.stats.blocked}｜待启动 ${f.stats.ready}`,
    CRITICAL: f.criticalPath.path.length ? `${f.criticalPath.path.join(' → ')}（剩余 ${f.criticalPath.len} 人日）` : '无未完成关键路径',
    OWNED: owned,
    ADMINS: adminList(project).join('、') || '未设置（写回会被拒绝，先找队长设置）',
  };
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in map ? map[k] : m));
}