import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ghJson } from './gh.mjs';
import { complete } from './llm.mjs';
import { validatePlan } from './project.mjs';

const DOC_PRIORITY = /分工|里程碑|计划|现状|简报|路线|plan|roadmap|milestone|task/i;
const MAX_DOC_CHARS = 6000;
const MAX_TOTAL_CHARS = 24000;
const MAX_DOCS = 5;

function pickDocs(names) {
  const md = names.filter((n) => n.endsWith('.md'));
  return [...md.filter((n) => DOC_PRIORITY.test(n)), ...md.filter((n) => !DOC_PRIORITY.test(n))].slice(0, MAX_DOCS);
}

function readLocalDocs(localRepo) {
  const docs = [];
  const readme = join(localRepo, 'README.md');
  if (existsSync(readme)) docs.push({ path: 'README.md', text: readFileSync(readme, 'utf8').slice(0, MAX_DOC_CHARS) });
  const docsDir = join(localRepo, 'docs');
  if (existsSync(docsDir)) {
    for (const name of pickDocs(readdirSync(docsDir))) {
      docs.push({ path: `docs/${name}`, text: readFileSync(join(docsDir, name), 'utf8').slice(0, MAX_DOC_CHARS) });
    }
  }
  return docs.slice(0, MAX_DOCS);
}

async function readRemoteDocs(repo, branch) {
  const docs = [];
  try {
    const r = await ghJson(`repos/${repo}/contents/README.md?ref=${encodeURIComponent(branch)}`, { retries: 2 });
    if (r?.content) docs.push({ path: 'README.md', text: Buffer.from(r.content, 'base64').toString('utf8').slice(0, MAX_DOC_CHARS) });
  } catch {}
  try {
    const list = await ghJson(`repos/${repo}/contents/docs?ref=${encodeURIComponent(branch)}`, { retries: 2 });
    if (Array.isArray(list)) {
      for (const name of pickDocs(list.map((f) => f.name))) {
        try {
          const f = await ghJson(`repos/${repo}/contents/docs/${encodeURIComponent(name)}?ref=${encodeURIComponent(branch)}`, { retries: 2 });
          if (f?.content) docs.push({ path: `docs/${name}`, text: Buffer.from(f.content, 'base64').toString('utf8').slice(0, MAX_DOC_CHARS) });
        } catch {}
      }
    }
  } catch {}
  return docs.slice(0, MAX_DOCS);
}

export async function gatherSources(root, { repo, branch = 'main', localRepo = null, id = null }) {
  let docs = localRepo && existsSync(localRepo) ? readLocalDocs(localRepo) : await readRemoteDocs(repo, branch);
  let total = docs.reduce((s, d) => s + d.text.length, 0);
  while (docs.length > 1 && total > MAX_TOTAL_CHARS) {
    const dropped = docs.pop();
    total -= dropped.text.length;
  }
  let issues = [];
  const cachePath = id ? join(root, 'cache', id, 'raw.json') : null;
  if (cachePath && existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, 'utf8'));
      issues = (raw.issues || []).filter((i) => !i.is_pr).map((i) => ({ number: i.number, title: i.title, state: i.state, body: (i.body || '').slice(0, 400) }));
    } catch {}
  } else {
    try {
      const list = await ghJson(`repos/${repo}/issues?state=open&per_page=50`, { retries: 2 });
      issues = (list || []).filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state, body: (i.body || '').slice(0, 400) }));
    } catch {}
  }
  return { docs, issues: issues.slice(0, 30) };
}

export function buildDraftMessages(sources, members) {
  const memberHint = members && Object.keys(members).length
    ? `成员代号与名字：${Object.entries(members).map(([k, m]) => `${k}=${m.name || k}`).join('、')}。owner 只能填这些代号；文档里没写归属的节点 owner 填 null，不要猜。`
    : '还没有成员表：所有节点 owner 填 null，等人来认领。';
  const docsText = sources.docs.map((d) => `### 文档 ${d.path}\n${d.text}`).join('\n\n') || '（仓库里没有可读文档）';
  const issuesText = sources.issues.length
    ? sources.issues.map((i) => `- #${i.number} [${i.state}] ${i.title}\n${i.body}`).join('\n')
    : '（没有 open issue）';
  return [
    {
      role: 'system',
      content: [
        '你是项目计划拆解助手。把仓库文档和 issue 拆成可审计的任务节点，只输出一个 JSON 对象，不要解释、不要 markdown 围栏。',
        'JSON 形如 {"project":"项目名","nodes":[{"id":"A1","title":"...","owner":"A","est":"M","deps":[],"files":[],"acceptance":"..."}]}。',
        '硬规则：id 用字母数字开头；est 只能 S/M/L（约 1/3/8 人日）；deps 只引用本次输出里存在的 id，不许有环；',
        'acceptance 必须是一条能验证的标准（测试通过/指标阈值/产物入库），不写「完成开发」这类空话；',
        'files 只填文档里明确提到的路径，没提到就留空数组；节点数不超过 40；',
        '文档没写的不要编：宁可节点少，不要假节点。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `${memberHint}\n\n${docsText}\n\n### open issue\n${issuesText}\n\n请输出计划 JSON。`,
    },
  ];
}

export function parseDraft(text) {
  let s = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型输出里没有 JSON 对象');
  const plan = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(plan.nodes)) throw new Error('模型输出的 JSON 缺 nodes 数组');
  plan.nodes = plan.nodes.map((n) => {
    const node = { ...n, deps: Array.isArray(n.deps) ? n.deps : [], files: Array.isArray(n.files) ? n.files : [] };
    if (typeof node.owner !== 'string') delete node.owner;
    return node;
  });
  return plan;
}

export async function planDraft(root, { repo, branch = 'main', localRepo = null, id = null, members = null, log = () => {} }) {
  const sources = await gatherSources(root, { repo, branch, localRepo, id });
  if (!sources.docs.length && !sources.issues.length) {
    throw new Error('仓库里没读到文档也没有 issue，无从拆解；先补 README 或分工文档，或手写 plan.json');
  }
  log(`[plan-draft] 来源：${sources.docs.map((d) => d.path).join('、') || '无文档'} + ${sources.issues.length} 条 issue`);
  const messages = buildDraftMessages(sources, members);
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await complete(root, messages, { temperature: 0.2, maxTokens: 6000 });
    let plan;
    try {
      plan = parseDraft(text);
      validatePlan(plan);
    } catch (err) {
      lastErr = err;
      log(`[plan-draft] 第 ${attempt} 版不合格：${String(err.message).slice(0, 200)}`);
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: `上一版有问题：${String(err.message).slice(0, 600)}。修正后重新只输出 JSON。` });
      continue;
    }
    return { plan, sources: { docs: sources.docs.map((d) => d.path), issues: sources.issues.length }, attempts: attempt };
  }
  throw new Error(`模型两版都没产出合格计划：${String(lastErr?.message).slice(0, 300)}`);
}