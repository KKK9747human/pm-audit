import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { complete } from './llm.mjs';
import { loadBundle } from './bundle.mjs';
import { pmStamp, pmFooter } from './brand.mjs';
import { postWatchComment } from './comment.mjs';

const tagOf = (text) => {
  const m = /\[([A-C]\d+)\]/.exec(text || '');
  return m ? m[1] : null;
};

function localStat(localRepo, sha) {
  if (!localRepo) return null;
  try {
    return execFileSync('git', ['-C', localRepo, 'show', '--stat', '--format=%s', sha], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export async function watchOnce(project, root, { comment = true, log = console.log } = {}) {
  const cacheDir = join(root, 'cache', project.id);
  const raw = JSON.parse(readFileSync(join(cacheDir, 'raw.json'), 'utf8'));
  const seenPath = join(cacheDir, 'seen.json');
  const seen = existsSync(seenPath) ? JSON.parse(readFileSync(seenPath, 'utf8')) : null;

  const all = raw.branchCommits.flatMap((b) => b.commits.map((c) => ({ ...c, branch: b.name })));
  const shas = [...new Set(all.map((c) => c.sha))].sort();
  if (!seen) {
    writeFileSync(seenPath, JSON.stringify({ initializedAt: new Date().toISOString(), shas }, null, 2), 'utf8');
    log(`[watch] ${project.id} 首次运行，登记 ${shas.length} 个已有提交，不解读`);
    return { written: [], comments: [] };
  }

  const seenSet = new Set(seen.shas);
  const fresh = all.filter((c) => !seenSet.has(c.sha) && c.parents < 2 && !/^\[PM\]/.test(c.message || ''));
  if (!fresh.length) {
    log(`[watch] ${project.id} 无新提交`);
    return { written: [], comments: [] };
  }

  const bundle = loadBundle(root, project.id);
  const facts = bundle?.facts;
  const groups = new Map();
  for (const c of fresh) {
    const arr = groups.get(c.branch) || [];
    arr.push(c);
    groups.set(c.branch, arr);
  }

  const outDir = join(root, 'data', project.id, 'interpretations');
  mkdirSync(outDir, { recursive: true });
  const written = [];
  const comments = [];

  for (const [branch, commits] of [...groups.entries()].slice(0, 3)) {
    commits.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const nodeId = branch.startsWith('task/') ? branch.slice(5) : tagOf(commits[0]?.message);
    const node = nodeId ? project.plan.nodes.find((n) => n.id === nodeId) : null;
    const nodeFacts = nodeId && facts ? facts.nodes.find((n) => n.id === nodeId) : null;

    const stats = commits
      .slice(0, 4)
      .map((c, i) => {
        const stat = localStat(project.localRepo, c.sha);
        return `${i + 1}. ${c.sha} ${c.message}${stat ? `\n${stat.split('\n').slice(1, 8).join('\n')}` : ''}`;
      })
      .join('\n\n');

    const context = [
      node
        ? `任务节点 ${node.id}：${node.title}\n验收标准：${node.acceptance || '—'}\n依赖：${(node.deps || []).join(',') || '无'}\n当前状态：${nodeFacts?.state || '未知'}，空闲 ${nodeFacts?.daysIdle ?? '—'} 天`
        : '这组提交没有关联任务节点（分支名不是 task/<节点号>，提交也没有 [节点号] 标记）。',
    ].join('\n');

    const prompt = [
      '你是团队的代码审计助手。下面是某个分支刚推送的一批提交。',
      context,
      '',
      '提交与改动：',
      stats,
      '',
      '只根据上面的内容输出三段，中文，每段最多两句：',
      '1. 这版做了什么（不要猜没出现在改动里的东西）',
      '2. 与任务验收标准偏离的地方（没有就写"无"）',
      '3. 下一步一句（具体到文件或命令）',
    ].join('\n');

    let answer = '';
    try {
      answer = await complete(root, [
        { role: 'system', content: '你是严格的代码审计助手，宁少不多，不编造。' },
        { role: 'user', content: prompt },
      ]);
    } catch (err) {
      answer = `（模型调用失败：${String(err.message).slice(0, 160)}）`;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const file = join(outDir, `${stamp}-${branch.replace(/[\\/:*?"<>|]/g, '_')}-${commits[0].sha.slice(0, 7)}.md`);
    const body = [
      `# [PM] ${branch} @ ${commits[0].sha.slice(0, 7)}`,
      '',
      pmStamp({ kind: '提交解读', project, asOf: bundle?.asOf, hash: bundle?.hashes?.facts }),
      '',
      `- 节点：${nodeId || '未关联'}`,
      `- 提交：${commits.map((c) => `${c.sha} ${c.message}`).join('；')}`,
      `- 生成：${new Date().toISOString()}`,
      '',
      answer || '（空）',
      pmFooter(),
    ].join('\n');
    writeFileSync(file, body, 'utf8');
    written.push(file);
    log(`[watch] ${project.id} ${branch}: 写出 ${file}`);
    if (comment) {
      try {
        const r = await postWatchComment(project, { branch, sha: commits[0].sha, body });
        comments.push({ branch, ...r });
        if (r.status === 'posted' || r.status === 'updated') log(`[watch] ${project.id} ${branch}: 已评论 PR #${r.pr}`);
        else log(`[watch] ${project.id} ${branch}: 没有 open PR，跳过评论`);
      } catch (err) {
        log(`[watch] ${project.id} ${branch}: 评论失败 ${String(err.message).slice(0, 120)}`);
      }
    }
  }

  const merged = [...new Set([...seen.shas, ...shas])].sort();
  writeFileSync(seenPath, JSON.stringify({ updatedAt: new Date().toISOString(), shas: merged }, null, 2), 'utf8');
  return { written, comments };
}
