import { execFileSync } from 'node:child_process';
import { ghJson } from './gh.mjs';
import { pmStamp, shortHash } from './brand.mjs';

export function buildProgressNote(project, bundle) {
  const f = bundle.facts;
  const s = f.stats;
  const path = (f.criticalPath?.path || []).join('→') || '—';
  const blocked = f.nodes.filter((n) => n.state === 'blocked').slice(0, 5);
  const lines = [
    `## [PM] 进度备注`,
    '',
    pmStamp({ kind: '进度备注', project, asOf: bundle.asOf, hash: bundle.hashes.facts }),
    '',
    `- 节点：${s.nodes} 个｜完成 ${s.done}｜进行中 ${s.active}｜停滞 ${s.stale}｜阻塞 ${s.blocked}｜待启动 ${s.ready}`,
    `- 关键路径：${path}（${f.criticalPath?.len ?? '—'} 人日）`,
    `- 未关联提交分支：${(f.unlinked || []).length} 个`,
    '',
  ];
  if (blocked.length) {
    lines.push('**当前卡点**：');
    for (const n of blocked) lines.push(`- ${n.id} ${n.title}（等 ${n.blockedBy.join('/')}）`);
    lines.push('');
  }
  lines.push('> 本评论由 PM 审计台生成，只读不改代码。');
  return lines.join('\n');
}

export async function postProgressNote(project, bundle, prNumber) {
  const marker = `<!-- pm:progress=${shortHash(bundle.hashes.facts)} -->`;
  const body = `${buildProgressNote(project, bundle)}\n\n${marker}`;
  const existing = await listComments(project, prNumber);
  const mine = (Array.isArray(existing) ? existing : []).find((c) => String(c.body || '').includes(marker));
  if (mine) {
    await ghJson(`repos/${project.repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body } });
    return { status: 'updated', pr: prNumber, comment: mine.id };
  }
  const c = await ghJson(`repos/${project.repo}/issues/${prNumber}/comments`, { method: 'POST', body: { body } });
  return { status: 'posted', pr: prNumber, comment: c?.id || null };
}


function head(project, branch) {
  const owner = project.repo.split('/')[0];
  return `${owner}:${branch}`;
}

export function findOpenPr(project, branch) {
  try {
    const list = execFileSync(
      'gh',
      ['api', `repos/${project.repo}/pulls?state=open&per_page=100`],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const prs = JSON.parse(list);
    const target = head(project, branch).toLowerCase();
    return prs.find((p) => `${p.head.label}`.toLowerCase() === target || `${p.head.repo?.owner?.login}:${p.head.ref}`.toLowerCase() === target) || null;
  } catch {
    return null;
  }
}

async function listComments(project, number) {
  try {
    return await ghJson(`repos/${project.repo}/issues/${number}/comments?per_page=100`, { retries: 2 });
  } catch {
    return [];
  }
}

export async function postWatchComment(project, { branch, sha, body }) {
  const pr = findOpenPr(project, branch);
  if (!pr) return { status: 'no-pr', branch };
  const marker = `<!-- pm:watch=${branch}@${sha.slice(0, 7)} -->`;
  const text = `${body}\n\n${marker}`;
  const existing = await listComments(project, pr.number);
  const mine = (Array.isArray(existing) ? existing : []).find((c) => String(c.body || '').includes(marker));
  if (mine) {
    await ghJson(`repos/${project.repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body: text } });
    return { status: 'updated', pr: pr.number, comment: mine.id };
  }
  const c = await ghJson(`repos/${project.repo}/issues/${pr.number}/comments`, { method: 'POST', body: { body: text } });
  return { status: 'posted', pr: pr.number, comment: c?.id || null };
}

export async function postNodeLink(project, { node, branch, message }) {
  const pr = findOpenPr(project, branch);
  if (!pr) return { status: 'no-pr', branch };
  const marker = `<!-- pm:node=${node} -->`;
  const text = message || `${marker}\n\n_[PM] 已把该分支的提交归位到节点 ${node}。_`;
  const c = await ghJson(`repos/${project.repo}/issues/${pr.number}/comments`, { method: 'POST', body: { body: text } });
  return { status: 'posted', pr: pr.number, comment: c?.id || null };
}

export function linkCommand(project, { node, branch }) {
  const pr = findOpenPr(project, branch);
  if (!pr) return { status: 'no-pr', branch };
  return { status: 'ok', pr: pr.number, command: `gh pr comment ${pr.number} --repo ${project.repo} --body "<!-- pm:node=${node} -->"` };
}
