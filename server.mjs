import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, getProject, createProject, setMemberGithub, setProjectAdmin, validatePlan } from './src/project.mjs';
import { loadBundle, saveBundle, verifyBundle } from './src/bundle.mjs';
import { loadBriefHistory } from './src/history.mjs';
import { loadEnv, resolveApiConfig, saveApiConfig, apiSettingsView } from './src/llm.mjs';
import { detectIdentity, identityLabel, clearIdentityCache, isAdmin, adminDenied, adminList } from './src/identity.mjs';
import { buildAgent, writeAgentLocal } from './src/agent.mjs';
import { syncFromRemote, publishBundle, confirmRemotePublish } from './src/remote.mjs';
import { watchOnce, probeRemote, signatureOf, decideRefresh, planRefresh, classifyProbe } from './src/watch.mjs';
import { linkCommand, postNodeLink, postProgressNote } from './src/comment.mjs';
import { buildTrail, renderTrail } from './src/trail.mjs';
import { renderOnboarding } from './src/onboard.mjs';
import { buildAlerts, alertCounts, renderAlerts } from './src/alerts.mjs';
import { buildNextActions } from './src/next-actions.mjs';
import { planDraft } from './src/plandraft.mjs';
import { normalizeBrief, runResearch, planFromIntake } from './src/intake.mjs';
import { getGithubAccount, createGithubRepo } from './src/github-repo.mjs';
import { readState, writeState, recordObservation, recordAudit, publishPending, pendingDecision, knownOwnCommits, reconcilePending, auditConsistency, applyAuditConsistency } from './src/refresh-state.mjs';
import { acquireProjectLock, releaseProjectLock, delegateProjectLock, assertProjectLock } from './src/project-lock.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PM_PORT || 7317);

let apiConfig = resolveApiConfig(loadEnv(root));

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

async function readBody(req, maxBytes = 0) {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (maxBytes && size > maxBytes) {
      throw Object.assign(new Error('请求体过大'), { code: 'PAYLOAD_TOO_LARGE' });
    }
    body += chunk;
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function modelReady() {
  return !apiConfig.requiresKey || Boolean(apiConfig.key);
}

const MAX_INTAKE_BODY = 1024 * 1024;


function settingsView() {
  return apiSettingsView(apiConfig);
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
  if (apiConfig.requiresKey && !apiConfig.key) return send(res, 400, { error: '还没有配置 API key，点左下角「API 设置」' });
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
    const headers = { 'Content-Type': 'application/json' };
    if (apiConfig.key) headers.Authorization = `Bearer ${apiConfig.key}`;
    upstream = await fetch(`${apiConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: apiConfig.model,
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
async function syncProject(id, { force = false, lock = null } = {}) {
  const hit = syncCache.get(id);
  if (!force && hit && Date.now() - hit.at < 60000) return hit.result;
  const project = getProject(root, id);
  const result = await syncFromRemote(root, project, { lock });
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
  const lock = acquireProjectLock(root, id, { timeout: 0 });
  if (!lock.acquired) return send(res, 409, { error: lock.error.message, code: 'BUSY' });
  try {
    const bundle = loadBundle(root, id);
    if (!bundle) return send(res, 404, { error: '还没有审计数据' });
    const r = await publishBundle(root, project, bundle);
    if (r.status === 'published') syncCache.delete(id);
    return send(res, 200, r);
  } catch (err) {
    const code = err.code === 'FORBIDDEN' ? 403 : err.code === 'CONFLICT' ? 409 : 500;
    return send(res, code, { error: String(err.message).slice(0, 400), conflict: err.code === 'CONFLICT' });
  } finally {
    releaseProjectLock(lock);
  }
}

async function handleInterpret(res, id) {
  const project = getProject(root, id);
  const role = roleOf(project);
  const lock = acquireProjectLock(root, id, { timeout: 0 });
  if (!lock.acquired) return send(res, 409, { error: lock.error.message, code: 'BUSY' });
  try {
    const r = await watchOnce(project, root, { comment: role.isAdmin });
    return send(res, 200, { ok: true, written: r.written.length, comments: r.comments, readOnly: !role.isAdmin });
  } catch (err) {
    return send(res, 500, { error: String(err.message).slice(0, 300) });
  } finally {
    releaseProjectLock(lock);
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
const readRefreshState = (id) => readState(root, id, 'server');
const writeRefreshState = (id, state) => writeState(root, id, 'server', state);
function execFileP(cmd, args, opts) {
  return new Promise((resolve) => {
    let result;
    const child = execFile(cmd, args, opts, (err, stdout, stderr) => {
      result = { err, stdout: stdout || '', stderr: stderr || '' };
    });
    // An error callback can precede close; retain the project lock until the child is reaped.
    child.once('close', () => resolve(result));
  });
}

async function handleRefresh(res, id, auto) {
  let projectLock = null;
  if (refreshing.has(id)) return send(res, 409, { error: '这个项目正在刷新' });
  refreshing.add(id);
  let tracking = false;
  try {
    const project = getProject(root, id);
    const role = roleOf(project);
    if (!role.isAdmin) {
      const r = await syncProject(id, { force: true });
      const bundle = loadBundle(root, id);
      const failed = r.status === 'invalid' || r.status === 'untrusted';
      return send(res, failed ? 502 : 200, {
        ok: !failed, readOnly: true, admin: role.admin,
        hash: bundle?.hashes?.facts || null,
        publish: { status: 'read-only' }, sync: r,
        ...(failed ? { error: `只读同步失败：${r.error || r.status}` } : {}),
      });
    }

    projectLock = acquireProjectLock(root, id, { timeout: 0 });
    if (!projectLock.acquired) return send(res, 409, { error: projectLock.error.message, code: 'BUSY' });

    let prev = readRefreshState(id);
    tracking = true;
    const reconciled = prev?.pendingPublish?.attemptId
      ? await reconcilePending(root, project, {
          kind: 'server', hash: prev.pendingPublish.hash, attemptId: prev.pendingPublish.attemptId,
          confirm: confirmRemotePublish,
        }, projectLock)
      : null;
    prev = readRefreshState(id);
    const tickCount = (prev?.tickCount || 0) + 1;
    let nextSignature = null;
    let nextProbe = null;
    let decision;
    let probeFailed = false;
    try {
      nextProbe = await probeRemote(project, { prevProbe: prev?.auditedProbe, knownOwn: knownOwnCommits(prev) });
      nextSignature = signatureOf(nextProbe);
      recordObservation(root, id, 'server', { signature: nextSignature, probe: nextProbe }, projectLock);
      const classification = classifyProbe({
        prevProbe: prev?.auditedProbe || null,
        nextProbe,
        knownOwn: knownOwnCommits(prev),
        projectId: id,
      });
      if (classification.unknown) throw new Error(classification.reason);
      decision = classification.ownOnly
        ? { refresh: auto && tickCount % 6 === 0, real: false, reason: classification.reason, ownOnly: true }
        : decideRefresh({
              prevSignature: prev?.auditedSignature ?? null,
              nextSignature, fresh: false, tickCount, fullEvery: auto ? 6 : 0,
            });
    } catch (err) {
      if (auto) throw err;
      probeFailed = true;
      decision = { refresh: true, real: false, reason: '远端探针失败，仅本地重算' };
    }

    const consistency = auditConsistency(root, id, prev);
    let bundle = consistency.bundle;
    const pending = pendingDecision({ state: prev, hash: bundle?.hashes?.facts || null, allowPublish: true });
    if (reconciled?.status === 'confirmed' && !decision.real && !probeFailed) decision.refresh = false;
    decision = applyAuditConsistency(decision, consistency);
    const plan = planRefresh({ auto, decision });
    if ((plan.skip || (reconciled?.status === 'confirmed' && !decision.refresh)) && !pending.publish) {
      writeRefreshState(id, { ...readRefreshState(id), tickCount, failures: 0, lastError: null, lastRunAt: new Date().toISOString() });
      return send(res, 200, { ok: true, skipped: true, reason: decision.reason, hash: bundle?.hashes?.facts || null });
    }
    plan.publish = !probeFailed && (plan.publish || pending.publish);
    const retryOnly = pending.publish && !pending.audit && !decision.refresh;
    let stdout = '';
    let interpreted = null;
    if (!retryOnly) {
      const run = await execFileP(
        process.execPath,
        [join(root, 'bin', 'pmctl.mjs'), 'audit', id, '--fresh', '--parent-lock'],
        { cwd: root, timeout: 600000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
          env: { ...process.env, PM_AUDIT_LOCK: delegateProjectLock(projectLock) } },
      );
      if (run.err) {
        if (run.err.code === 70) {
          return send(res, 409, { error: '项目正在由另一个进程处理', code: 'BUSY' });
        }
        throw run.err;
      }
      stdout = run.stdout;
      bundle = loadBundle(root, id);
      if (!bundle) throw new Error('审计未生成数据包，未推进检查点');
      recordAudit(root, id, 'server', {
        hash: bundle.hashes.facts,
        signature: probeFailed || decision.unknown ? null : nextSignature,
        probe: probeFailed || decision.unknown ? null : nextProbe,
        publish: plan.publish,
      }, projectLock);
      if (!apiConfig.requiresKey || apiConfig.key) {
        try {
          interpreted = await watchOnce(getProject(root, id), root, { comment: !probeFailed, log: () => {} });
        } catch (err) {
          interpreted = { error: String(err.message).slice(0, 200) };
        }
      }
    }

    let publish = plan.publish
      ? await publishPending(root, project, bundle, {
          kind: 'server',
          signature: readRefreshState(id)?.pendingPublish?.signature ?? null,
          publish: (target) => publishBundle(root, getProject(root, id), target),
        }, projectLock)
      : { status: 'local-only', reason: decision.reason };
    if (publish.code === 'CONFLICT') {
      try {
        const synced = await syncProject(id, { force: true, lock: projectLock });
        if (synced.status === 'invalid' || synced.status === 'untrusted') {
          throw new Error(`冲突同步失败：${synced.error || synced.status}`);
        }
        const retryProbe = await probeRemote(project);
        if (!retryProbe?.snapshotComplete) throw new Error('冲突同步后的远端探针不完整，等待重试');
        const retrySignature = signatureOf(retryProbe);
        const run = await execFileP(
          process.execPath,
          [join(root, 'bin', 'pmctl.mjs'), 'audit', id, '--fresh', '--parent-lock'],
          { cwd: root, timeout: 600000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
            env: { ...process.env, PM_AUDIT_LOCK: delegateProjectLock(projectLock) } },
        );
        if (run.err) throw run.err;
        bundle = loadBundle(root, id);
        if (!bundle) throw new Error('冲突重算未生成数据包');
        stdout = run.stdout;
        recordAudit(root, id, 'server', {
          hash: bundle.hashes.facts, signature: retrySignature, probe: retryProbe, publish: true,
        }, projectLock);
        publish = await publishPending(root, project, bundle, {
          kind: 'server', signature: retrySignature,
          publish: (target) => publishBundle(root, getProject(root, id), target),
        }, projectLock);
      } catch (err) {
        publish = { status: 'error', hash: bundle?.hashes?.facts || null, error: String(err.message).slice(0, 300), code: err.code || null };
      }
    }
    const failed = publish.status === 'error';
    writeRefreshState(id, {
      ...readRefreshState(id), tickCount,
      failures: failed ? (prev?.failures || 0) + 1 : 0,
      lastError: failed ? publish.error : null,
      lastPublished: plan.publish ? publish : prev?.lastPublished || null,
      lastRunAt: new Date().toISOString(),
    });
    return send(res, 200, {
      ok: !failed, tail: stdout.slice(-600), hash: bundle?.hashes?.facts || null, publish,
      interpreted: interpreted
        ? { written: interpreted.written?.length ?? 0, comments: interpreted.comments || [], error: interpreted.error || null }
        : null,
    });
  } catch (err) {
    if (tracking) {
      try {
        assertProjectLock(root, id, projectLock);
        const state = readRefreshState(id) || {};
        writeRefreshState(id, { ...state, failures: (state.failures || 0) + 1, lastError: String(err.message).slice(0, 300) });
      } catch {}
    }
    return send(res, 500, { error: String(err.message).slice(0, 300) });
  } finally {
    refreshing.delete(id);
    if (projectLock) releaseProjectLock(projectLock);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;
  try {
    if (path === '/api/health') return send(res, 200, { ok: true, provider: apiConfig.provider, model: apiConfig.model, hasKey: Boolean(apiConfig.key) });
    if (path === '/api/settings' && req.method === 'GET') return send(res, 200, settingsView());
    if (path === '/api/settings' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        apiConfig = saveApiConfig(root, body);
        return send(res, 200, settingsView());
      } catch (err) {
        return send(res, 400, { error: String(err.message).slice(0, 300) });
      }
    }

    if (path === '/api/intake/research' && req.method === 'POST') {
      if (!modelReady()) return send(res, 400, { error: '生成调研需要模型：先点左下角「API 设置」配置' });
      let body;
      try {
        body = await readBody(req, MAX_INTAKE_BODY);
      } catch (err) {
        return send(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: err.message });
      }
      let brief;
      try {
        brief = normalizeBrief(body.brief);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      const repo = body.repo ? String(body.repo).trim() : null;
      if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return send(res, 400, { error: '仓库地址必须是 owner/name 形式' });
      try {
        const r = await runResearch(root, {
          brief,
          repo,
          branch: String(body.branch || 'main'),
          localRepo: body.local ? String(body.local) : null,
          provider: apiConfig.provider,
          model: apiConfig.model,
        });
        return send(res, 200, r);
      } catch (err) {
        return send(res, 502, { error: String(err.message).slice(0, 400) });
      }
    }

    if (path === '/api/intake/plan' && req.method === 'POST') {
      if (!modelReady()) return send(res, 400, { error: '生成计划需要模型：先点左下角「API 设置」配置' });
      let body;
      try {
        body = await readBody(req, MAX_INTAKE_BODY);
      } catch (err) {
        return send(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: err.message });
      }
      let brief;
      try {
        brief = normalizeBrief(body.brief);
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      const researchMarkdown = String(body.researchMarkdown || '').trim();
      if (!researchMarkdown) return send(res, 400, { error: '缺调研 Markdown；先生成或填写调研草稿' });
      if (researchMarkdown.length > 20000) return send(res, 400, { error: '调研 Markdown 超过 20000 字上限' });
      const repo = body.repo ? String(body.repo).trim() : null;
      if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return send(res, 400, { error: '仓库地址必须是 owner/name 形式' });
      const members = body.members && typeof body.members === 'object' && !Array.isArray(body.members) ? body.members : null;
      try {
        const r = await planFromIntake(root, {
          brief,
          researchMarkdown,
          repo,
          branch: String(body.branch || 'main'),
          localRepo: body.local ? String(body.local) : null,
          members,
        });
        return send(res, 200, r);
      } catch (err) {
        return send(res, 502, { error: String(err.message).slice(0, 400) });
      }
    }

    if (path === '/api/intake/validate-plan' && req.method === 'POST') {
      let body;
      try {
        body = await readBody(req, MAX_INTAKE_BODY);
      } catch (err) {
        return send(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: err.message });
      }
      const allowedOwners = body.members && typeof body.members === 'object' && !Array.isArray(body.members)
        ? Object.keys(body.members).filter(Boolean)
        : null;
      try {
        const r = validatePlan(body.plan, allowedOwners);
        return send(res, 200, { ok: true, nodes: r.nodes });
      } catch (err) {
        return send(res, 400, { error: err.message, details: Array.isArray(err.details) ? err.details : [] });
      }
    }

    if (path === '/api/github/account' && req.method === 'GET') {
      try {
        return send(res, 200, await getGithubAccount());
      } catch (err) {
        return send(res, /401|unauthorized|gh 不可用/i.test(String(err.message)) ? 401 : 502, { error: String(err.message).slice(0, 300) });
      }
    }

    if (path === '/api/github/repo' && req.method === 'POST') {
      let body;
      try {
        body = await readBody(req, 64 * 1024);
      } catch (err) {
        return send(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: err.message });
      }
      try {
        return send(res, 200, await createGithubRepo(body));
      } catch (err) {
        const status = ['CONFIRM_REQUIRED', 'BAD_REQUEST'].includes(err.code) ? 400 : err.code === 'REPO_EXISTS' ? 409 : 502;
        return send(res, status, { error: String(err.message).slice(0, 400), code: err.code || 'GH_ERROR' });
      }
    }

    if (path === '/api/plan-draft' && req.method === 'POST') {
      if (apiConfig.requiresKey && !apiConfig.key) return send(res, 400, { error: '生成草稿需要模型 key：先点左下角「API 设置」配置' });
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
        const admins = adminList(p);
        const ownerId = identity?.memberId || null;
        const mineCount =
          ownerId && b?.facts?.nodes?.length
            ? b.facts.nodes.filter((n) => n.owner === ownerId).length
            : 0;
        return {
          id: p.id,
          name: p.name,
          repo: p.repo,
          asOf: b?.asOf || null,
          hash: b?.hashes.facts || null,
          stats: b?.facts.stats || null,
          critical: b?.facts.criticalPath || null,
          identity,
          isAdmin: admins.length > 0 && isAdmin(p, identity),
          admin: admins.join('、') || null,
          mineCount,
          defaultBranch: p.defaultBranch || 'main',
          members: p.members || {},
        };
      });
      return send(res, 200, list);
    }

    if (path === '/api/projects' && req.method === 'POST') {
      let body;
      try {
        body = await readBody(req, MAX_INTAKE_BODY);
      } catch (err) {
        return send(res, err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: err.message });
      }
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
      let intake = null;
      if (body.intake) {
        try {
          intake = {
            ...body.intake,
            brief: normalizeBrief(body.intake.brief),
            provider: apiConfig.provider,
            model: apiConfig.model,
          };
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
      }
      try {
        const lock = acquireProjectLock(root, body.id, { timeout: 0 });
        if (!lock.acquired) return send(res, 409, { error: lock.error.message, code: 'BUSY' });
        try {
          const p = createProject(root, {
            id: body.id,
            name: body.name,
            repo: body.repo,
            localRepo: body.localRepo || null,
            defaultBranch: body.defaultBranch || 'main',
            admin: detectIdentity({ id: body.id, localRepo: body.localRepo || null })?.login || null,
            members: body.members || plan.members || {},
            plan,
            planSource: body.planSource || plan.source || '',
            intake,
          });
          return send(res, 200, { id: p.id });
        } finally {
          releaseProjectLock(lock);
        }
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
      const lock = acquireProjectLock(root, bundle.project.id, { timeout: 0 });
      if (!lock.acquired) return send(res, 409, { error: lock.error.message, code: 'BUSY' });
      try {
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
      } finally {
        releaseProjectLock(lock);
      }
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
      if (sub === '/refresh' && req.method === 'POST') return handleRefresh(res, id, url.searchParams.get('auto') === '1');
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
        const lock = acquireProjectLock(root, id, { timeout: 0 });
        if (!lock.acquired) return send(res, 409, { error: lock.error.message, code: 'BUSY' });
        try {
          const members = setMemberGithub(root, id, body.memberId, body.github || null);
          clearIdentityCache(project);
          const identity = detectIdentity(getProject(root, id));
          return send(res, 200, { ok: true, members, identity, label: identityLabel(identity) });
        } catch (err) {
          return send(res, 400, { error: String(err.message).slice(0, 200) });
        } finally {
          releaseProjectLock(lock);
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
          verify = { ok: false, code: err.code || null, expected: b.hashes?.facts || null, actual: null, error: String(err.message).slice(0, 200) };
        }
        return send(res, 200, { trail: buildTrail(b), verify, markdown: renderTrail(b, verify) });
      }
      if (sub === '/alerts' && req.method === 'GET') {
        const b = loadBundle(root, id);
        if (!b) return send(res, 404, { error: '还没有审计数据' });
        const project = getProject(root, id);
        const alerts = buildAlerts(b.facts, { staleDays: project.staleDays });
        const next = buildNextActions(b.facts, { staleDays: project.staleDays }, 3);
        return send(res, 200, {
          alerts,
          counts: alertCounts(alerts),
          next,
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
  console.log(`模型: ${apiConfig.model} ｜ key: ${apiConfig.key ? '已配置' : apiConfig.requiresKey ? '未配置（左下角设置）' : '无需'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      rmSync(join(root, 'tmp', 'server.pid'), { force: true });
    } catch {}
    process.exit(0);
  });
}
