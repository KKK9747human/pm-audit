import { mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pmStamp, pmFooter, shortHash } from './brand.mjs';
import { writeAtomicFile } from './project-lock.mjs';

export const AGENT_FORMAT = 'pm-audit/agent';
export const AGENT_VERSION = 1;

function nextFor(n) {
  const out = [];
  if (n.state === 'done') {
    out.push('本节点已完成，无需继续实现。');
    out.push('如需复盘，从「证据」里的 issue / PR / 提交链回看。');
    return out;
  }
  if (n.state === 'blocked') {
    out.push(`先等 ${n.blockedBy.join('、')} 完成；在此之前不要动本节点，避免返工。`);
    out.push('依赖合入后，从「验收标准」第一条重新评估是否还需要全做。');
    return out;
  }
  if (n.state === 'stale') {
    out.push(`最后活动在 ${n.daysIdle ?? '?'} 天前。先确认这条线是不是停了。`);
    out.push(`把当前进展落到 task/${n.id} 分支或对应 issue，再继续。`);
    return out;
  }
  if (n.state === 'active') {
    out.push(`继续在 ${n.branch || `task/${n.id}`} 上推进，提交或 PR 标题带 [${n.id}]。`);
    out.push('下一刀切在验收标准里还没满足的那一条，不要顺手改别的节点。');
    return out;
  }
  out.push(`从验收标准开始：${n.acceptance || '（计划里没写验收，先补一条可验证的）'}`);
  if (n.files?.length) out.push(`先从这些文件入手：${n.files.slice(0, 3).join('、')}。`);
  out.push(`开分支 task/${n.id}，首个提交标题带 [${n.id}]。`);
  return out;
}

function evidenceLines(n) {
  const issues = n.evidence?.issues ?? n.issues ?? [];
  const prs = n.evidence?.prs ?? n.prs ?? [];
  const commits = n.evidence?.commits ?? n.commits ?? [];
  const branch = n.evidence?.branch ?? n.branch;
  const lines = [];
  for (const i of issues) lines.push(`- issue #${i.number}（${i.state}）${i.title}`);
  for (const p of prs) lines.push(`- PR #${p.number}（${p.merged_at ? '已合并' : p.state}）${p.head_ref || ''}`);
  if (branch) lines.push(`- 分支 ${branch}`);
  for (const c of commits.slice(0, 5)) {
    lines.push(`- 提交 ${c.sha} ${String(c.date || '').slice(0, 10)} ${c.message}`);
  }
  return lines.length ? lines : ['- 还没有关联证据。'];
}

function upstreamLines(n, byId) {
  if (!n.deps?.length) return ['- 无上游依赖。'];
  const lines = [];
  for (const depId of n.deps) {
    const dep = byId.get(depId);
    if (!dep) {
      lines.push(`- ${depId}：计划里找不到这个节点，先向 PM 报告，不要自己猜。`);
      continue;
    }
    const ev = dep.evidence || {};
    const evidenceCount = (ev.prs?.length || 0) + (ev.commits?.length || 0);
    const noEvidence = dep.state === 'done' && evidenceCount === 0;
    const mark = noEvidence ? '⚠️ 计划标 done，但没有与该节点关联的 issue / PR / 提交记录（可能改动没挂到节点上，也可能确实没做）' : '';
    lines.push(`- ${depId}《${dep.title}》：计划状态 ${dep.state}${mark}`);
  }
  lines.push('');
  lines.push('本节只反映**计划状态**，不证明代码已实现。开工前自行核对 deps 的代码现状；');
  lines.push('发现「计划 done 但代码里找不到对应改动」时，先报告差异，不要默认它可以开工。');
  return lines;
}

function commandLines(n, label, items) {
  if (!items?.length) return [`- 计划未给出${label}：先读相关文件和现有测试核实，**不要编造命令**。`];
  return items.map((cmd) => `- \`${String(cmd).replace(/`/g, '\\`')}\``);
}

const STOP_CONDITIONS = [
  '当前仓库状态与本简报明显冲突。',
  '节点已由其他 PR 实现，先核对再决定是否继续。',
  '依赖未完成，而本任务没有授权绕过依赖。',
  '需要修改计划、降低验收标准或扩大权限。',
  '所需文件、接口或验证命令不存在，无法安全继续。',
  '需要远端写入，但没有明确授权。',
];

function nodeMarkdown(project, bundle, n) {
  const head = [
    `# [PM] ${n.id} · ${n.title}`,
    '',
    pmStamp({ kind: '节点简报', project, asOf: bundle.asOf, hash: bundle.hashes.facts }),
    '',
    `> 生产规范见 \`.pm/${project.id}/AGENT.md\`（版本核对、任务边界、写回约定、完成定义）。`,
    '',
    `- 目标代码仓库：${project.repo}｜默认分支：${project.defaultBranch || 'main'}`,
    '- 开工前核对本机工作目录与 Git 远端，确认进入上述目标代码仓库，而不是 PM 工具目录。',
    '- 这份简报不代表认领或远端写入授权；先确认负责人和现有 PR，避免重复实现。',
    `- 负责人：${n.owner}（${n.ownerName || '未登记'}）`,
    `- 状态：${n.state}｜工期：${n.est}（约 ${n.days} 人日）｜空闲：${n.daysIdle == null ? '无活动记录' : `${n.daysIdle} 天`}`,
    `- 依赖：${n.deps.join('、') || '无'}｜下游：${n.downstream} 个未完成节点｜关键路径：${n.onCriticalPath ? '是' : '否'}`,
    `- 本次目标：只完成本节点的验收标准，不顺手改其他节点。`,
    '',
    '## 验收标准',
    '',
    n.acceptance || '（计划里没写；先补一条可验证的验收标准，不要自行放宽）',
    '',
    '## 验收命令',
    '',
    ...commandLines(n, '验收命令', n.verify),
    '',
    '## 下一步（给 Agent 执行）',
    '',
    ...n.next.map((x, i) => `${i + 1}. ${x}`),
    '',
    '## 涉及文件',
    '',
    ...(n.files?.length ? n.files.map((f) => `- \`${f}\``) : ['- 未指定']),
    '',
    '## 环境前提',
    '',
    ...commandLines(n, '环境前提', n.env),
    '',
    '## 运行期依赖',
    '',
    ...commandLines(n, '运行期依赖', n.runtimeDeps),
    '',
    '## 上游状态核对',
    '',
    ...upstreamLines(n, new Map(bundle.facts.nodes.map((x) => [x.id, x]))),
    '',
    '## 证据',
    '',
    ...evidenceLines(n),
    '',
    '## 停止条件（遇到就先报告，不要硬做）',
    '',
    ...STOP_CONDITIONS.map((x) => `- ${x}`),
    '',
    '## 完成写法',
    '',
    `- PR 正文写 \`<!-- pm:node=${n.id} -->\`，或合并前关闭对应 issue。`,
    `- 同时写 \`<!-- pm:base=${bundle.hashes.facts} -->\`，声明基于这一版简报。`,
    `- 提交标题带 \`[${n.id}]\`，分支建议 \`task/${n.id}\`。`,
    '- `pm:base` 是开始工作时依据的审计快照；后续快照更新后它落后是可能的，不要伪造成新指纹。',
    '',
    '## 完成后报告格式',
    '',
    '节点｜分支｜sha/PR｜做了什么｜验收逐条对照（没做写「未完成+原因」）｜剩余风险｜基于的数据版本（asOf + hash）。',
    '',
    pmFooter(),
  ];
  return head.join('\n');
}

function buildGuide(project, bundle) {
  const id = project.id;
  const lines = [
    `# [PM] ${project.name} · AI 生产指导`,
    '',
    pmStamp({ kind: '生产指导', project, asOf: bundle.asOf, hash: bundle.hashes.facts }),
    '',
    '本文件由 PM 审计台生成，是给执行任务的 AI agent 的唯一生产指导；数据一变会整份覆盖，不要手改。',
    '节点级细节看 `agent/tasks/<节点>.md`，机器可读版本看 `agent/index.json`。',
    '',
    '## 0. 开工前先核对版本',
    '',
    `- 读 \`.pm/${id}/manifest.json\`，把它的 \`hash\` 与 \`agent/index.json\` 的 \`hash\` 对比。`,
    `- 目标代码仓库是 ${project.repo}，默认分支 ${project.defaultBranch || 'main'}；先核对工作目录和 Git 远端。`,
    `- 不一致就先在 PM 工具目录运行 \`node bin/pmctl.mjs sync ${id}\` 或在 PM 界面「同步」，再获取新简报；目标仓库不一定安装了 PM，不能直接假设这些命令存在。`,
    '- 离线时必须在本轮汇报里写明基于哪个 hash；收到简报不代表已经认领，也不授予远端写入权限。',
    '- 只读 `.pm/`；计划要改，找管理员改 `projects/<id>/plan.json` 后重新审计，不要自行修正计划。',
    '',
    '## 1. 事实来源与边界',
    '',
    '- 唯一事实源是 bundle 里的 facts；本目录所有文档都是它的翻译，不要引入第三种状态。',
    '- 状态含义：done 已完成｜active 进行中｜stale 停滞｜blocked 依赖未满足｜ready 可开工。',
    '- 计划外提交不算任何节点的证据，不能拿来充当完成依据。',
    '- 一次只做一个节点；验收标准之外的不顺手改，不扩范围。',
    '',
    '## 2. 选任务顺序',
    '',
    '1. `agent/index.json` 里 `forYou: true` 或 `identity.ownedNodes` 里的节点。',
    '2. 关键路径上的节点（`criticalPath`）。',
    '3. `blockedBy` 为空且状态为 ready / active 的节点。',
    '4. 其余先问负责人或 PM，不要自己挑。',
    '',
    '## 3. 写回证据（PM 只认这些）',
    '',
    '- 分支：`task/<节点ID>`；一个节点一个分支、一个 PR。',
    '- 提交标题带 `[<节点ID>]`，例如 `[A2] 修复采集参数`。',
    '- PR 正文写 `<!-- pm:node=<节点ID> -->`；如果要自动关 issue，再加 `Closes #<issue>`。',
    `- 同一段正文里写 \`<!-- pm:base=${bundle.hashes.facts} -->\`，声明基于哪版简报；PM 会与当前指纹比对，不一致会标「基于旧简报」。`,
    '- 不要在同一个 PR 里混入别的节点；跨节点的改动拆开提交或拆 PR。',
    '',
    '## 4. 什么时候算完成',
    '',
    '- PM 只从 GitHub 推导状态：PR 合并或 issue 关闭才记 done，本地提交不算。',
    '- 对照「验收标准」逐条给出结果；没做或做不了要写「未完成 + 原因」，不要写「基本完成」。',
    '- 完成后再看下游节点是否因此解锁；不要提前动下游。',
    '',
    '## 5. 卡住了怎么办',
    '',
    '- 依赖没合入：停手，按 `blockedBy` 报告等谁，不要绕开或造假接口。',
    '- 计划与代码现状冲突：先报告差异，等 PM 更新计划，不要自行改计划或验收标准。',
    '- 证据挂不上（分支名、提交标题、PR 标记都没有）：在汇报里给出分支和 sha，让 PM 手动归位。',
    '',
    '## 6. 汇报格式',
    '',
    '节点｜分支｜sha/PR｜做了什么｜验收逐条对照｜剩余风险｜基于的数据版本（asOf + hash）。',
    '',
    '## 7. 禁止',
    '',
    '- 不手改 `.pm/**`、`data/**`、`plan.json`。',
    '- 不把密钥、令牌写进仓库、提交或 PR。',
    '- 不在依赖未确认时批量改多个节点，不伪造完成状态。',
    '',
    '## 8. 现有数据规模',
    '',
    `- ${bundle.facts.stats.nodes} 个节点：完成 ${bundle.facts.stats.done}｜进行中 ${bundle.facts.stats.active}｜停滞 ${bundle.facts.stats.stale}｜阻塞 ${bundle.facts.stats.blocked}｜待启动 ${bundle.facts.stats.ready}`,
    `- 关键路径：${bundle.facts.criticalPath.path.join('→') || '—'}（${bundle.facts.criticalPath.len} 人日）`,
    '',
    pmFooter(),
  ];
  return lines.join('\n');
}

export function buildAgent(project, bundle, identity) {
  const f = bundle.facts;
  const own = identity?.memberId;
  const nodes = f.nodes.map((n) => ({
    id: n.id,
    title: n.title,
    owner: n.owner,
    ownerName: project.members?.[n.owner]?.name || null,
    state: n.state,
    est: n.est,
    days: n.days,
    daysIdle: n.daysIdle,
    onCriticalPath: n.onCriticalPath,
    downstream: n.downstream,
    deps: n.deps,
    blockedBy: n.blockedBy,
    acceptance: n.acceptance || '',
    files: n.files || [],
    verify: n.verify || null,
    env: n.env || null,
    runtimeDeps: n.runtimeDeps || null,
    evidence: {
      issues: n.issues,
      prs: n.prs,
      branch: n.branch,
      commits: (n.commits || []).slice(0, 8),
    },
    forYou: Boolean(own && n.owner === own),
    next: nextFor(n),
    markdownPath: `.pm/${project.id}/agent/tasks/${n.id}.md`,
  }));

  const index = {
    generatedBy: 'PM',
    format: AGENT_FORMAT,
    version: AGENT_VERSION,
    project: {
      id: project.id,
      name: project.name,
      repo: project.repo,
      defaultBranch: project.defaultBranch || 'main',
      planSource: project.planSource || '',
    },
    asOf: bundle.asOf,
    hash: bundle.hashes.facts,
    identity: identity
      ? {
          login: identity.login,
          email: identity.email,
          memberId: identity.memberId,
          memberName: identity.memberName,
          ownedNodes: nodes.filter((n) => n.forYou).map((n) => n.id),
        }
      : null,
    stats: f.stats,
    criticalPath: f.criticalPath,
    nodes,
    rules: [
      `开工前先读 .pm/${project.id}/AGENT.md，核对 manifest hash 后再动手。`,
      '只依据本文件与节点证据执行，不要自行扩大任务范围。',
      '改完一个节点，用 task/<id> 分支或 [<id>] 提交标题把证据挂回去。',
      '遇到依赖未完成时停手，先报告阻塞，不要绕开。',
    ],
  };

  const files = nodes.map((n) => ({
    path: index.nodes.find((x) => x.id === n.id).markdownPath,
    content: nodeMarkdown(project, bundle, n),
  }));

  const readme = [
    `# [PM] ${project.name} · 自动生成目录`,
    '',
    pmStamp({ kind: '数据目录', project, asOf: bundle.asOf, hash: bundle.hashes.facts }),
    '',
    '这个目录由 PM 自动维护，用来让其他人或 AI agent 直接读进度：',
    '',
    '- `AGENT.md`：给 AI 的生产指导（版本核对、选任务、写回约定、完成定义、禁止事项）。',
    '- `trail.md`：证据链审计——每个完成节点对应哪个合并 PR、哪些提交、哪些证据文件，附指纹校验结果。',
    '- `bundle.parts/*.b64`：完整数据包的 gzip 分片（base64），PM 自动拼接、校验 sha256 后导入。',
    '- `agent/index.json`：全部节点的结构化简报（负责人、状态、验收、依赖、证据、下一步）。',
    '- `agent/tasks/<节点>.md`：单节点执行简报，给 agent 或人看。',
    '- `interpretations/`：每次新提交的 AI 解读。',
    '- `manifest.json`：本次发布指纹与文件清单，PM 客户端靠它判断是否有更新。',
    '',
    '不要手改这些文件；下次发布会被覆盖。',
    pmFooter(),
  ].join('\n');

  return {
    index,
    files,
    guide: buildGuide(project, bundle),
    readme,
    nodeMarkdown: (n) => nodeMarkdown(project, bundle, typeof n === 'string' ? nodes.find((x) => x.id === n) : n),
  };
}

export function writeAgentLocal(root, project, bundle, identity) {
  const agent = buildAgent(project, bundle, identity);
  const dir = join(root, 'data', project.id, 'agent');
  const tasksDir = join(dir, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const kept = new Set();
  for (const f of agent.files) {
    const name = f.path.split('/').pop();
    kept.add(name);
    writeAtomicFile(join(tasksDir, name), f.content);
  }
  writeAtomicFile(join(dir, 'AGENT.md'), agent.guide);
  // index.json 是读者入口，最后落：崩溃时它指向的整组简报要么旧、要么新。
  writeAtomicFile(join(dir, 'index.json'), `${JSON.stringify(agent.index, null, 2)}\n`);
  for (const name of readdirSync(tasksDir)) {
    if (!kept.has(name)) rmSync(join(tasksDir, name), { force: true });
  }
  return agent;
}

export function agentMarkdownPath(project, nodeId) {
  return `.pm/${project.id}/agent/tasks/${nodeId}.md`;
}

export { shortHash };
