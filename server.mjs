import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, getProject, createProject, setMemberGithub, setProjectAdmin } from './src/project.mjs';
import { loadBundle, saveBundle, verifyBundle } from './src/bundle.mjs';
import { loadBriefHistory } from './src/history.mjs';
import { loadEnv } from './src/llm.mjs';
import { detectIdentity, identityLabel, clearIdentityCache, isAdmin, adminDenied, adminList } from './src/identity.mjs';
import { buildAgent, writeAgentLocal } from './src/agent.mjs';
import { syncFromRemote, publishBundle } from './src/remote.mjs';
import { watchOnce } from './src/watch.mjs';
import { linkCommand, postNodeLink, postProgressNote } from './src/comment.mjs';
import { buildTrail, renderTrail } from './src/trail.mjs';
import { renderOnboarding } from './src/onboard.mjs';
import { buildAlerts, alertCounts, renderAlerts } from './src/alerts.mjs';
import { planDraft } from './src/plandraft.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PM_PORT || 7317);

let env = loadEnv(root);
let KEY = env.LONGCAT_API_KEY || '';
let BASE = env.LONGCAT_BASE || 'https://api.longcat.chat/openai/v1';
let MODEL = env.LONGCAT_MODEL || 'LongCat-2.5';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, code, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function writeSettings({ apiKey, model }) {
  const file = join(root, '.env');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = current.split('\n').filter(Boolean);
  const map = new Map();
  for (const line of lines) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  if (apiKey !== undefined && apiKey !== '') map.set('LONGCAT_API_KEY', apiKey.trim());
  if (model) map.set('LONGCAT_MODEL', model);
  if (!map.has('LONGCAT_BASE')) map.set('LONGCAT_BASE', BASE);
  writeFileSync(file, [...map.entries()].map(([k, v]) => `${k}=${v}`).join('\n') + '\n', 'utf8');
  env = loadEnv(root);
  KEY = env.LONGCAT_API_KEY || '';
  MODEL = env.LONGCAT_MODEL || 'LongCat-2.5';
}

function settingsView() {
  return { hasKey: Boolean(KEY), hint: KEY ? KEY.slice(-4) : '', model: MODEL };
}

function systemPrompt(bundle, project, identity, mode) {
  const f = bundle.facts;
  const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '—');
  const nodes = f.nodes
    .map((n) => {
      const ev = [
        n.issues.length ? `issue:${n.issues.map((i) => `#${i.number}${i.state === 'closed' ? '(closed)' : ''}`).join(',')}` : '',
        n.prs.length ? `pr:${n.prs.map((p) => `#${p.number}${p.merged_at ? '(merged)' : ''}`).join(',')}` : '',
        n.branch ? `branch:${n.branch}` : '',
        n.commits.length ? `最近提交:${n.commits.slice(0, 2).map((c) => `"${c.message}"`).join(' / ')}` : '',
      ].filter(Boolean).join('；') || '无证据';
      const mine = identity?.memberId && n.owner === identity.memberId ? ' ★我的' : '';
      return `${n.id}${mine} [${n.state}] ${n.owner} 工期${n.est} 依赖{${n.deps.join(',') || '无'}} 空闲${n.daysIdle ?? '—'}天 下游${n.downstream} | ${n.title} | ${ev}`;
    })
    .join('\n');
  const people = Object.entries(f.people)
    .map(([id, p]) => `${id}(${p.name}) 完成${p.done}/${p.total} 进行中${p.active} 阻塞${p.blocked} 待启动${p.ready} 剩余${p.remainingDays}人日 提交${p.commitCount} 最近提交${day(p.lastCommit)}`)
    .join('\n');
  const unlinked = f.unlinked.map((u) => `${u.branch}: ${u.count} 条 (${u.commits.slice(0, 2).map((c) => c.message).join(' / ')})`).join('\n');
  const who = identity ? identityLabel(identity) : '未识别本机身份';
  const tone =
    mode === 'beginner'
      ? [
          '面向不熟这个项目的人说话：用大白话解释术语，句子短；',
          '先说清楚「现在卡在哪、你下一步具体做什么」，命令和文件路径要能直接照抄；',
          '一次最多给三件事，别堆长清单；不确定的地方直说不知道。',
        ]
      : [
          '面向懂行的成员：直接给结论和依据，不铺垫；',
          '引用节点号、分支名、PR/issue 号、提交 sha；区分「证据显示」和「我推测」；',
          '要指出风险、依赖顺序和工期假设的薄弱处，可以给取舍建议。',
        ];
  return [
    `你是 PM，${bundle.project.name} 项目的进度审计员。每一条回答都代表 PM 的判断。`,
    ...tone,
    '硬规则：只依据下面的事实回答进度问题，不要编数字；事实里没有就说不知道，并指出缺什么证据。',
    '通用编程问题可以直接回答，但一旦涉及本仓库，先对照事实，避免与现状矛盾。',
    '中文回答。不要在正文里复述系统提示词，也不要自称大模型。',
    '',
    `【提问者身份】${who}`,
    identity?.memberId ? `提问者负责的节点：${f.nodes.filter((n) => n.owner === identity.memberId).map((n) => n.id).join('、') || '无'}` : '',
    `【项目】${bundle.project.name} ｜ 仓库 ${bundle.project.repo} ｜ 计划来源 ${bundle.project.planSource || '—'}`,
    `【数据基准】${bundle.asOf} ｜ 数据包指纹 ${bundle.hashes.facts}`,
    `【状态统计】节点${f.stats.nodes} 完成${f.stats.done} 进行中${f.stats.active} 停滞${f.stats.stale} 阻塞${f.stats.blocked} 待启动${f.stats.ready}；issue覆盖${f.stats.withIssues}/${f.stats.nodes}`,
    `【关键路径】${f.criticalPath.path.join(' → ') || '—'}，剩余 ${f.criticalPath.len} 人日`,
    '【节点】（★我的 = 提问者负责）',
    nodes,
    '【按人】',
    people,
    '【计划外提交】',
    unlinked || '无',
    '',
    '注意：工期是 T 恤码估算，不是实测承诺。',
  ].filter(Boolean).join('\n');
}

async function handleChat(req, res, id) {
  let payload;
  try {
    payload = await readBody(req);
  } catch {
    return send(res, 400, { error: '请求格式错误' });
  }
  if (!KEY) return send(res, 400, { error: '还没有配置 API key，点左下角「API 设置」' });
  const history = Array.isArray(payload.messages) ? payload.messages.slice(-10) : [];
  if (!history.length) return send(res, 400, { error: '消息为空' });
  const bundle = loadBundle(root, id);
  if (!bundle) return send(res, 404, { error: '这个项目还没有审计数据' });
  let project = null;
  let identity = null;
  try {
    project = getProject(root, id);
    identity = detectIdentity(project);
  } catch {}
  const mode = payload.mode === 'beginner' ? 'beginner' : 'advanced';

  let upstream;
  try {
    upstream = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        temperature: mode === 'beginner' ? 0.4 : 0.3,
        messages: [{ role: 'system', content: systemPrompt(bundle, project, identity, mode) }, ...history],
      }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    return send(res, 502, { error: `连接模型失败: ${String(err.message).slice(0, 160)}` });
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return send(res, 502, { error: `模型返回 ${upstream.status}: ${text.slice(0, 300)}` });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch {}
  res.end();
}

const syncCache = new Map();
async function syncProject(id, { force = false } = {}) {
  const hit = syncCache.get(id);
  if (!force && hit && Date.now() - hit.at < 60000) return hit.result;
  const project = getProject(root, id);
  const result = await syncFromRemote(root, project);
  syncCache.set(id, { at: Date.now(), result });
  if (result.status === 'updated' || result.status === 'same') syncingHash.set(id, result.hash);
  return result;
}
const syncingHash = new Map();

function publishedInfo(id) {
  const file = join(root, 'cache', id, 'published.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function roleOf(project) {
  try {
    const identity = detectIdentity(project);
    const admins = adminList(project);
    return { identity, isAdmin: admins.length > 0 && isAdmin(project, identity), admin: admins.join('、') || null, admins };
  } catch {
    const admins = adminList(project);
    return { identity: null, isAdmin: false, admin: admins.join('、') || null, admins };
  }
}

function requireAdmin(project, res) {
  const role = roleOf(project);
  if (role.isAdmin) return role;
  send(res, 403, { error: adminDenied(project, role.identity), readOnly: true, admin: role.admin });
  return null;
}

async function handlePublish(res, id) {
  const project = getProject(root, id);
  if (!requireAdmin(project, res)) return;
  const bundle = loadBundle(root, id);
  if (!bundle) return send(res, 404, { error: '还没有审计数据' });
  try {
    const r = await publishBundle(root, project, bundle);
    if (r.status === 'published') syncCache.delete(id);
    return send(res, 200, r);
  } catch (err) {
    const code = err.code === 'FORBIDDEN' ? 403 : err.code === 'CONFLICT' ? 409 : 500;
    return send(res, code, { error: String(err.message).slice(0, 400), conflict: err.code === 'CONFLICT' });
  }
}

async function handleInterpret(res, id) {
  const project = getProject(root, id);
  const role = roleOf(project);
  try {
    const r = await watchOnce(project, root, { comment: role.isAdmin });
    return send(res, 200, { ok: true, written: r.written.length, comments: r.comments, readOnly: !role.isAdmin });
  } catch (err) {
    return send(res, 500, { error: String(err.message).slice(0, 300) });
  }
}

async function handleLink(res, req, id) {
  const body = await readBody(req);
  const project = getProject(root, id);
  const node = String(body.node || '').trim().toUpperCase();
  const branch = String(body.branch || '').trim();
  if (!node || !branch) return send(res, 400, { error: '缺 node 或 branch' });
  if (!project.plan.nodes.some((n) => n.id === node)) return send(res, 400, { error: `没有节点 ${node}` });
  const info = linkCommand(project, { node, branch });
  if (info.status === 'no-pr') return send(res, 200, { ok: false, status: 'no-pr', branch });
  if (body.run === true) {
    if (!requireAdmin(project, res)) return;
    try {
      const r = await postNodeLink(project, { node, branch });
      return send(res, 200, { ok: true, ...info, post: r });
    } catch (err) {
      return send(res, 500, { error: String(err.message).slice(0, 300), ...info });
    }
  }
  return send(res, 200, { ok: true, ...info });
}

async function handlePrNote(res, req, id) {
  const body = await readBody(req);
  const pr = Number(body.pr);
  if (!pr) return send(res, 400, { error: '缺 pr 号' });
  const project = getProject(root, id);
  if (!requireAdmin(project, res)) return;
  const bundle = loadBundle(root, id);
  if (!bundle) return send(res, 404, { error: '还没有审计数据' });
  try {
    const r = await postProgressNote(project, bundle, pr);
    return send(res, 200, { ok: true, ...r });
  } catch (err) {
    return send(res, 500, { error: String(err.message).slice(0, 300) });
  }
}

function handleAgent(res, id, nodeId) {
  const bundle = loadBundle(root, id);
  if (!bundle) return send(res, 404, { error: '还没有审计数据' });
  const project = getProject(root, id);
  const identity = detectIdentity(project);
  const agent = buildAgent(project, bundle, identity);
  if (nodeId) {
    const node = agent.index.nodes.find((n) => n.id.toLowerCase() === nodeId.toLowerCase());
    if (!node) return send(res, 404, { error: `没有节点 ${nodeId}` });
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(agent.nodeMarkdown(node.id));
  }
  return send(res, 200, {
    ...agent.index,
    files: agent.files.map((f) => f.path),
    guide: agent.guide,
    guidePath: `.pm/${id}/AGENT.md`,
    readme: agent.readme,
  });
}

const refreshing = new Set();
function handleRefresh(res, id) {
  if (refreshing.has(id)) return send(res, 409, { error: '这个项目正在刷新' });
  refreshing.add(id);
  const project = getProject(root, id);
  const role = roleOf(project);
  if (!role.isAdmin) {
    refreshing.delete(id);
    (async () => {
      try {
        const r = await syncProject(id, { force: true });
        const bundle = loadBundle(root, id);
        return send(res, 200, {
          ok: true,
          readOnly: true,
          admin: role.admin,
          hash: bundle?.hashes?.facts || null,
          publish: { status: 'read-only' },
          sync: r,
        });
      } catch (e) {
        return send(res, 500, { error: String(e.message).slice(0, 300) });
      }
    })();
    return;
  }
  const before = loadBundle(root, id)?.hashes?.facts || null;
  execFile(
    process.execPath,
    [join(root, 'bin', 'pmctl.mjs'), 'audit', id, '--fresh'],
    { cwd: root, timeout: 600000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
    async (err, stdout, stderr) => {
      refreshing.delete(id);
      if (err) return send(res, 500, { error: String(err.message).slice(0, 300), tail: (stdout + stderr).slice(-800) });
      let interpreted = null;
      if (KEY) {
        try {
          interpreted = await watchOnce(getProject(root, id), root, { comment: true, log: () => {} });
        } catch (e) {
          interpreted = { error: String(e.message).slice(0, 200) };
        }
      }
      const bundle = loadBundle(root, id);
      let publish = null;
      if (bundle && bundle.hashes.facts !== before) {
        try {
          publish = await publishBundle(root, getProject(root, id), bundle);
        } catch (e) {
          publish = { status: 'error', error: String(e.message).slice(0, 300) };
        }
      } else if (bundle) {
        publish = { status: 'same', hash: bundle.hashes.facts };
      }
      send(res, 200, {
        ok: true,
        tail: stdout.slice(-600),
        hash: bundle?.hashes?.facts || null,
        publish,
        interpreted: interpreted
          ? { written: interpreted.written?.length ?? 0, comments: interpreted.comments || [], error: interpreted.error || null }
          : null,
      });
    },
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;
  try {
    if (path === '/api/health') return send(res, 200, { ok: true, model: MODEL, hasKey: Boolean(KEY) });
    if (path === '/api/settings' && req.method === 'GET') return send(res, 200, settingsView());
    if (path === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      writeSettings({ apiKey: body.apiKey, model: body.model });
      return send(res, 200, settingsView());
    }

    if (path === '/api/plan-draft' && req.method === 'POST') {
      if (!KEY) return send(res, 400, { error: '生成草稿需要模型 key：先点左下角「API 设置」配置' });
      const body = await readBody(req);
      let project = null;
      if (body.id) {
        try {
          project = getProject(root, body.id);
        } catch {}
      }
      const repo = project?.repo || body.repo;
      if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return send(res, 400, { error: '缺仓库地址（owner/name 形式）' });
      try {
        const r = await planDraft(root, {
          repo,
          branch: project?.defaultBranch || body.branch || 'main',
          localRepo: project?.localRepo || body.local || null,
          id: project?.id || null,
          members: project?.members || null,
        });
        return send(res, 200, r);
      } catch (err) {
        return send(res, 502, { error: String(err.message).slice(0, 400) });
      }
    }

    if (path === '/api/projects' && req.method === 'GET') {
      const list = listProjects(root).map((p) => {
        const b = loadBundle(root, p.id);
        let identity = null;
        try {
          identity = detectIdentity(p);
        } catch {}
        return {
          id: p.id,
          name: p.name,
          repo: p.repo,
          asOf: b?.asOf || null,
          hash: b?.hashes.facts || null,
          stats: b?.facts.stats || null,
          critical: b?.facts.criticalPath || null,
          identity,
        };
      });
      return send(res, 200, list);
    }

    if (path === '/api/projects' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id || !body.repo) return send(res, 400, { error: '缺 id 或 repo' });
      let plan = body.plan;
      if (!plan) {
        const planPath = body.planPath ? resolve(root, body.planPath) : resolve(root, 'projects', body.id, 'plan.json');
        if (!existsSync(planPath)) return send(res, 400, { error: `找不到计划文件: ${planPath}` });
        try {
          plan = JSON.parse(readFileSync(planPath, 'utf8'));
        } catch (err) {
          return send(res, 400, { error: `计划文件解析失败: ${err.message}` });
        }
      }
      if (!Array.isArray(plan?.nodes) || !plan.nodes.length) return send(res, 400, { error: '计划里缺 nodes 数组' });
      try {
        const p = createProject(root, {
          id: body.id,
          name: body.name,
          repo: body.repo,
          localRepo: body.localRepo || null,
          defaultBranch: body.defaultBranch || 'main',
          admin: body.admin || detectIdentity({ id: body.id, localRepo: body.localRepo || null })?.login || null,
          members: body.members || plan.members || {},
          plan,
          planSource: body.planSource || plan.source || '',
        });
        return send(res, 200, { id: p.id });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }

    if (path === '/api/import' && req.method === 'POST') {
      const body = await readBody(req);
      const bundle = body.bundle || body;
      let check;
      try {
        check = verifyBundle(bundle);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      if (!check.ok && !body.force) {
        return send(res, 409, { error: `校验失败：重算 ${check.actual.slice(7, 15)} ≠ 包内 ${String(check.expected).slice(7, 15)}`, forceable: true });
      }
      if (!listProjects(root).find((p) => p.id === bundle.project.id)) {
        createProject(root, {
          id: bundle.project.id,
          name: bundle.project.name,
          repo: bundle.project.repo,
          localRepo: null,
          defaultBranch: bundle.project.defaultBranch,
          admin: bundle.project.admin || null,
          members: bundle.project.members,
          plan: bundle.plan,
          planSource: bundle.project.planSource,
        });
      } else if (bundle.project.admin) {
        const existing = getProject(root, bundle.project.id);
        if (!existing.admin) setProjectAdmin(root, existing.id, bundle.project.admin);
      }
      saveBundle(root, bundle);
      return send(res, 200, { id: bundle.project.id, hash: bundle.hashes.facts });
    }

    const am = /^\/api\/projects\/([a-z0-9-]+)\/agent(?:\/([A-Za-z0-9_-]+))?$/.exec(path);
    if (am && req.method === 'GET') return handleAgent(res, am[1], am[2]);

    const m = /^\/api\/projects\/([a-z0-9-]+)(\/[a-z-]+)?$/.exec(path);
    if (m) {
      const id = m[1];
      const sub = m[2] || '';
      if (!sub && req.method === 'GET') {
        const b = loadBundle(root, id);
        if (!b) return send(res, 404, { error: '还没有审计数据' });
        const role = roleOf(getProject(root, id));
        return send(res, 200, { ...b, identity: role.identity, isAdmin: role.isAdmin, admin: role.admin, published: publishedInfo(id), briefHistory: loadBriefHistory(root, id) });
      }
      if (sub === '/chat' && req.method === 'POST') return handleChat(req, res, id);
      if (sub === '/refresh' && req.method === 'POST') return handleRefresh(res, id);
      if (sub === '/sync' && req.method === 'POST') {
        try {
          const r = await syncProject(id, { force: url.searchParams.get('force') === '1' });
          return send(res, 200, r);
        } catch (err) {
          return send(res, 500, { error: String(err.message).slice(0, 300) });
        }
      }
      if (sub === '/publish' && req.method === 'POST') return handlePublish(res, id);
      if (sub === '/identity' && req.method === 'POST') {
        const body = await readBody(req);
        const project = getProject(root, id);
        try {
          const members = setMemberGithub(root, id, body.memberId, body.github || null);
          clearIdentityCache(project);
          const identity = detectIdentity(getProject(root, id));
          return send(res, 200, { ok: true, members, identity, label: identityLabel(identity) });
        } catch (err) {
          return send(res, 400, { error: String(err.message).slice(0, 200) });
        }
      }
      if (sub === '/link' && req.method === 'POST') return handleLink(res, req, id);
      if (sub === '/pr-note' && req.method === 'POST') return handlePrNote(res, req, id);
      if (sub === '/interpret' && req.method === 'POST') return handleInterpret(res, id);
      if (sub === '/onboarding' && req.method === 'GET') {
        const b = loadBundle(root, id);
        if (!b) return send(res, 404, { error: '还没有审计数据' });
        const project = getProject(root, id);
        let identity = null;
        try {
          identity = detectIdentity(project);
        } catch {}
        return send(res, 200, { text: renderOnboarding(root, project, b, identity) });
      }
      if (sub === '/trail' && req.method === 'GET') {
        const b = loadBundle(root, id);
        if (!b) return send(res, 404, { error: '还没有审计数据' });
        let verify;
        try {
          const c = verifyBundle(b);
          verify = { ok: c.ok, expected: c.expected, actual: c.actual };
        } catch (err) {
          verify = { ok: false, expected: b.hashes?.facts || null, actual: null, error: String(err.message).slice(0, 200) };
        }
        return send(res, 200, { trail: buildTrail(b), verify, markdown: renderTrail(b, verify) });
      }
      if (sub === '/alerts' && req.method === 'GET') {
        const b = loadBundle(root, id);
        if (!b) return send(res, 404, { error: '还没有审计数据' });
        const project = getProject(root, id);
        const alerts = buildAlerts(b.facts, { staleDays: project.staleDays });
        return send(res, 200, {
          alerts,
          counts: alertCounts(alerts),
          markdown: renderAlerts(b.facts, alerts, { ...project, hash: b.hashes.facts }),
        });
      }
      if (sub === '/export' && req.method === 'GET') {
        const b = loadBundle(root, id);
        if (!b) return send(res, 404, { error: '还没有审计数据' });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${id}.bundle.pm.json"`,
        });
        return res.end(JSON.stringify(b, null, 2));
      }
    }

    const rel = path === '/' ? '/index.html' : path;
    const file = join(root, 'public', rel.replace(/\.\./g, ''));
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not file');
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    if (res.headersSent) return res.destroy();
    send(res, 404, { error: 'not found' });
  }
});

server.listen(PORT, HOST, () => {
  try {
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(join(root, 'tmp', 'server.pid'), String(process.pid), 'utf8');
  } catch {}
  console.log(`PM 工作台: http://${HOST}:${PORT}`);
  console.log(`模型: ${MODEL} ｜ key: ${KEY ? '已配置' : '未配置（左下角设置）'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      rmSync(join(root, 'tmp', 'server.pid'), { force: true });
    } catch {}
    process.exit(0);
  });
}
