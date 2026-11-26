#!/usr/bin/env node
import { readFileSync, mkdirSync, existsSync, accessSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from '../src/ingest.mjs';
import { buildFacts } from '../src/facts.mjs';
import { renderAudit, renderMermaid } from '../src/render.mjs';
import { renderTrail } from '../src/trail.mjs';
import { renderOnboarding } from '../src/onboard.mjs';
import { buildAlerts, alertCounts, renderAlerts } from '../src/alerts.mjs';
import { planDraft } from '../src/plandraft.mjs';
import { listProjects, getProject, pickProject, createProject } from '../src/project.mjs';
import { buildBundle, saveBundle, loadBundle, verifyBundle } from '../src/bundle.mjs';
import { rememberBriefing } from '../src/history.mjs';
import { watchOnce, probeRemote, signatureOf, decideRefresh, backoffDelay, classifyProbe } from '../src/watch.mjs';
import { writeAgentLocal, buildAgent } from '../src/agent.mjs';
import { detectIdentity, identityLabel, isAdmin, adminList } from '../src/identity.mjs';
import { syncFromRemote, publishBundle, adoptFromRemote, confirmRemotePublish } from '../src/remote.mjs';
import { linkCommand, postNodeLink, postProgressNote } from '../src/comment.mjs';
import { pmStamp, pmFooter } from '../src/brand.mjs';
import { ghJson } from '../src/gh.mjs';
import { loadEnv, resolveApiConfig } from '../src/llm.mjs';
import { readState, writeState, recordObservation, recordAudit, recordAuditBundle, publishPending, pendingDecision, knownOwnCommits, reconcilePending, auditConsistency, applyAuditConsistency } from '../src/refresh-state.mjs';
import { acquireProjectLock, releaseProjectLock, assertProjectLock, acceptProjectLockDelegation, clearStaleProjectLock, writeAtomicFile } from '../src/project-lock.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function withProjectLockWrite(root, id, operation, { timeout = 0 } = {}) {
  const lock = acquireProjectLock(root, id, { timeout });
  if (!lock.acquired) throw lock.error;
  try {
    return await operation();
  } finally {
    releaseProjectLock(lock);
  }
}

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

function auditFiles(project, bundle, facts) {
  const alerts = buildAlerts(facts, { staleDays: project.staleDays });
  return {
    'audit.md': renderAudit(facts, project, project.planSource),
    'dag.mmd': renderMermaid(facts),
    'trail.md': renderTrail(bundle, verifyBundle(bundle)),
    'alerts.json': JSON.stringify({ asOf: bundle.asOf, hash: bundle.hashes.facts, counts: alertCounts(alerts), alerts }, null, 2),
    'alerts.md': renderAlerts(facts, alerts, { ...project, hash: bundle.hashes.facts }),
  };
}

function auditIngest(project, { fresh, log, lock }) {
  const cachePath = join(root, 'cache', project.id, 'raw.json');
  if (!fresh && existsSync(cachePath)) return Promise.resolve(JSON.parse(readFileSync(cachePath, 'utf8')));
  return ingest(project, root, log, lock);
}

async function auditOne(project, { fresh = false, log = console.log, lock = null } = {}) {
  const held = lock
    ? assertProjectLock(root, project.id, lock)
    : acquireProjectLock(root, project.id, { timeout: 0 });
  if (!held.acquired) throw held.error;
  try {
    const raw = await auditIngest(project, { fresh, log, lock: held });
    const identity = detectIdentity(project);
    const facts = buildFacts(project.plan, raw, project, raw.fetchedAt);
    const bundle = buildBundle(project, raw, facts);
    const files = auditFiles(project, bundle, facts);
    recordAuditBundle(root, project.id, lock ? null : 'cli', bundle, files, { lock: held });
    assertProjectLock(root, project.id, held);
    writeAgentLocal(root, project, bundle, identity);
    assertProjectLock(root, project.id, held);
    rememberBriefing(root, project.id, bundle);
    return { bundle, facts, bundlePath: join(root, 'data', project.id, 'bundle.pm.json') };
  } finally {
    if (!lock) releaseProjectLock(held);
  }
}

async function publishWithRetry(root, project, bundle, signature, log = console.log, lock = null) {
  const attempt = (target, baseSignature) => publishPending(root, project, target, {
    kind: 'cli', signature: baseSignature,
    publish: (current) => publishBundle(root, project, current),
  }, lock);
  let result = await attempt(bundle, signature);
  if (result.code === 'CONFLICT') {
    log(`[watch] ${project.id} 写回冲突 → sync 后重算重试一次`);
    try {
      const synced = await syncFromRemote(root, project, { lock });
      if (synced.status === 'invalid' || synced.status === 'untrusted') {
        throw new Error(`冲突同步失败：${synced.error || synced.status}`);
      }
      const retryProbe = await probeRemote(project);
      if (!retryProbe?.snapshotComplete) throw new Error('冲突同步后的远端探针不完整，等待重试');
      const retrySignature = signatureOf(retryProbe);
      const again = await auditOne(project, { fresh: true, log, lock });
      bundle = again.bundle;
      recordAudit(root, project.id, 'cli', {
        hash: bundle.hashes.facts, signature: retrySignature, probe: retryProbe, publish: true,
      }, lock);
      result = await attempt(bundle, retrySignature);
    } catch (err) {
      result = { status: 'error', hash: bundle.hashes.facts, error: String(err.message).slice(0, 300), code: err.code || null };
    }
  }
  const label = result.status === 'same' ? '已是最新' : result.status === 'published' ? result.commit.slice(0, 8) : '失败';
  return { ...result, label, bundle };
}

const { flags, pos } = parseArgs(process.argv.slice(2));
const cmd = pos[0] || 'list';
const rest = pos.slice(1);

try {
  if (cmd === 'list') {
    const projects = listProjects(root);
    if (!projects.length) {
      console.log('还没有项目。用 project:add 添加，或 import 导入 bundle。');
    }
    for (const p of projects) {
      const b = loadBundle(root, p.id);
      if (!b) {
        console.log(`${p.id}\t${p.name}\t${p.repo}\t未审计`);
        continue;
      }
      const f = b.facts;
      console.log(
        `${p.id}\t${p.name}\t${f.stats.nodes}节点 阻塞${f.stats.blocked} 完成${f.stats.done}\t关键路径${f.criticalPath.len}人日\t${b.hashes.facts.slice(7, 15)}`,
      );
    }
  } else if (cmd === 'audit') {
    if (flags['no-lock']) throw new Error('--no-lock 不再支持，审计必须持有项目锁');
    if (flags['parent-lock'] && (flags.all || rest.length !== 1)) throw new Error('父进程锁委托必须指定单个项目');
    const delegated = flags['parent-lock'] ? acceptProjectLockDelegation(root, rest[0], process.env.PM_AUDIT_LOCK) : null;
    const projects = flags.all || !rest[0] ? listProjects(root) : [getProject(root, rest[0])];
    if (!projects.length) throw new Error('没有项目');
    for (const p of projects) {
      const { bundle, facts } = await auditOne(p, { fresh: Boolean(flags.fresh), lock: delegated });
      const s = facts.stats;
      console.log(
        `[${p.id}] ${s.nodes} 节点 | 完成 ${s.done} 进行中 ${s.active} 停滞 ${s.stale} 阻塞 ${s.blocked} 待启动 ${s.ready} | 关键路径 ${facts.criticalPath.path.join('→') || '—'} (${facts.criticalPath.len} 人日) | ${bundle.hashes.facts.slice(7, 15)}`,
      );
      console.log(`  data/${p.id}/bundle.pm.json`);
    }
  } else if (cmd === 'import') {
    const file = rest[0];
    if (!file) throw new Error('用法: pmctl import <bundle.pm.json> [--force]');
    const bundle = JSON.parse(readFileSync(file, 'utf8'));
    const check = verifyBundle(bundle);
    if (!check.ok && !flags.force) {
      throw new Error(`校验失败：重算 hash ${check.actual} ≠ 包内 ${check.expected}。确认版本后再用 --force。`);
    }
    const saved = await withProjectLockWrite(root, bundle.project.id, () => {
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
      }
      return saveBundle(root, bundle);
    });
    console.log(`已导入 ${bundle.project.id} → ${saved}（hash ${bundle.hashes.facts.slice(7, 15)}）`);
  } else if (cmd === 'project:add') {
    if (!flags.id || !flags.repo || !flags.plan) {
      throw new Error('用法: pmctl project:add --id <id> --repo owner/name --plan path/to/plan.json [--name X] [--local path] [--branch main] [--admin 登录名]');
    }
    const plan = JSON.parse(readFileSync(flags.plan, 'utf8'));
    const p = await withProjectLockWrite(root, flags.id, () => createProject(root, {
      id: flags.id,
      name: flags.name || flags.id,
      repo: flags.repo,
      localRepo: flags.local || null,
      defaultBranch: flags.branch || 'main',
      admin: flags.admin || detectIdentity({ id: flags.id, localRepo: flags.local || null })?.login || null,
      members: plan.members || {},
      plan,
      planSource: flags['plan-source'] || plan.source || '',
    }));
    console.log(`已创建项目 ${p.id} → ${p.dir}`);
    console.log(`下一步：node bin/pmctl.mjs audit ${p.id} --fresh`);
  } else if (cmd === 'adopt') {
    if (!flags.repo) throw new Error('用法: pmctl adopt --repo owner/name [--id 项目id] [--branch main] [--dry-run]');
    const r = await adoptFromRemote(root, {
      repo: flags.repo,
      id: typeof flags.id === 'string' ? flags.id : null,
      branch: flags.branch || 'main',
      dryRun: Boolean(flags['dry-run']),
      log: console.log,
    });
    if (r.status === 'dry-run') {
      console.log(`[dry-run] 远端有一份可用数据包：${r.id}`);
      console.log(`  基准 ${r.asOf} ｜ 指纹 ${r.hash.slice(7, 15)} ｜ ${r.nodes} 节点 ｜ 管理员 ${r.admin || '未设置'}`);
      console.log('去掉 --dry-run 即会在本机创建项目并保存数据包。');
    } else {
      console.log(`已接管项目 ${r.id} → projects/${r.id}（基准 ${r.asOf}，指纹 ${r.hash.slice(7, 15)}）`);
      console.log(`下一步：node bin/pmctl.mjs doctor ${r.id}，然后 npm start 打开工作台`);
    }
  } else if (cmd === 'doctor') {
    const apiConfig = resolveApiConfig(loadEnv(root));
    const out = [];
    const add = (level, text) => out.push(`[${level}] ${text}`);
    const major = Number(process.versions.node.split('.')[0]);
    add(major >= 18 ? 'ok' : 'fail', `Node ${process.versions.node}${major >= 18 ? '' : '（需要 18 或更高）'}`);
    try {
      accessSync(root, constants.W_OK | constants.R_OK);
      add('ok', `目录可读写 ${root}`);
    } catch {
      add('fail', `目录不可写 ${root}`);
    }
    const ready = !apiConfig.requiresKey || apiConfig.key;
    add(ready ? 'ok' : 'warn', ready
      ? `模型已配置：${apiConfig.provider} / ${apiConfig.model}${apiConfig.key ? '（key 已配置）' : '（无需 key）'}`
      : '模型 key 未配置：审计与写回不受影响，对话和提交解读不可用（界面左下角设置或 .env）');
    let login = null;
    const networkish = (err) => /dial tcp|connectex|timeout|timed out|TLS|handshake|ECONN|EAI_AGAIN|socket/i.test(String(err?.message || ''));
    if (!flags.offline) {
      try {
        const u = await ghJson('user', { retries: 3 });
        login = u?.login || null;
        add(login ? 'ok' : 'fail', login ? `gh 已登录：${login}` : 'gh 未登录：运行 gh auth login');
      } catch (err) {
        add(networkish(err) ? 'warn' : 'fail',
          networkish(err)
            ? 'GitHub 连接失败（网络问题，稍后重试 doctor）：审计刷新与写回会受影响'
            : `gh 不可用：${String(err.message).slice(0, 160)}（安装 gh 后运行 gh auth login）`);
      }
    } else {
      add('warn', '跳过网络检查（--offline）');
    }
    const ids = flags.all || !rest[0] ? listProjects(root) : [pickProject(root, rest[0])];
    if (!ids.length) add('warn', '本机还没有项目：用 project:add 新建，或 adopt --repo owner/name 接管已有项目');
    for (const p of ids) {
      const bundle = loadBundle(root, p.id);
      let identity = null;
      try {
        identity = detectIdentity(p);
      } catch {}
      const admins = adminList(p);
      add('ok', `项目 ${p.id} → ${p.repo}（${p.plan.nodes.length} 节点，管理员 ${admins.join('、') || '未设置'}）`);
      if (bundle) add('ok', `  本地数据包 ${bundle.asOf} ｜ ${bundle.hashes.facts.slice(7, 15)}`);
      else add('warn', '  本地还没有审计数据：先跑 audit 或 sync');
      if (!admins.length) add('warn', '  管理员未设置：写回会被拒绝，用 --admin 或界面设置');
      else if (identity?.login && isAdmin(p, identity)) add('ok', `  本机 ${identity.login} 是管理员（可写回）`);
      else if (identity?.login) add('warn', `  本机 ${identity.login} 是只读身份（管理员 ${admins.join('、')}）`);
      if (!flags.offline) {
        try {
          const repo = await ghJson(`repos/${p.repo}`, { retries: 3 });
          const perm = repo?.permissions || {};
          add('ok', `  仓库可访问：${p.repo}${perm.push ? '（有推送权限）' : '（只读或未返回权限，写回前确认）'}`);
        } catch (err) {
          add(networkish(err) ? 'warn' : 'fail', `  仓库不可访问：${String(err.message).slice(0, 160)}`);
        }
        try {
          const manifest = await ghJson(`repos/${p.repo}/contents/.pm/${p.id}/manifest.json?ref=${encodeURIComponent(p.defaultBranch || 'main')}`, { retries: 3 });
          add('ok', `  远端数据包存在：.pm/${p.id}/manifest.json${manifest?.sha ? `（${String(manifest.sha).slice(0, 8)}）` : ''}`);
        } catch (err) {
          if (networkish(err)) add('warn', `  远端数据包检查失败（网络问题）：${String(err.message).slice(0, 120)}`);
          else if (/404|not found/i.test(String(err.message))) add('warn', `  远端还没有 .pm/${p.id}/manifest.json（首次写回会创建）`);
          else add('warn', `  远端数据包不可读：${String(err.message).slice(0, 160)}`);
        }
      }
    }
    console.log(out.join('\n'));
    if (out.some((l) => l.startsWith('[fail]'))) process.exitCode = 1;
  } else if (cmd === 'watch') {
    const projects = flags.all || !rest[0] ? listProjects(root) : [getProject(root, rest[0])];
    if (!projects.length) throw new Error('没有项目');
    const interval = Number(flags.interval || 10) * 60 * 1000;
    const fullEvery = Number(flags['full-every'] || 6);
    const doPublish = Boolean(flags.publish);
    const interpret = !flags['no-interpret'];
    const readWatchState = (id) => readState(root, id, 'cli');
    const writeWatchState = (id, s) => writeState(root, id, 'cli', s);

    const tick = async () => {
      let worst = 0;
      for (const p of projects) {
        const lock = acquireProjectLock(root, p.id, { timeout: 0 });
        if (!lock.acquired) {
          worst = Math.max(worst, 1);
          console.error(`[watch] ${p.id} 跳过：${lock.error.message}`);
          continue;
        }
        let prev;
        let tickCount;
        let failures;
        try {
          prev = readWatchState(p.id);
          tickCount = (prev?.tickCount || 0) + 1;
          failures = prev?.failures || 0;
          if (!isAdmin(p, detectIdentity(p))) {
            const sync = await syncFromRemote(root, p, { lock });
            if (sync.status === 'invalid' || sync.status === 'untrusted') {
              throw new Error(`只读同步失败：${sync.error || sync.status}`);
            }
            if (failures) {
              writeWatchState(p.id, {
                ...readWatchState(p.id), tickCount, failures: 0,
                lastError: null, lastRunAt: new Date().toISOString(),
              });
            }
            console.log(`[watch] ${p.id} 只读同步：${sync.status}`);
            continue;
          }
          const reconciled = doPublish && prev?.pendingPublish?.attemptId
            ? await reconcilePending(root, p, {
                kind: 'cli', hash: prev.pendingPublish.hash, attemptId: prev.pendingPublish.attemptId,
                confirm: confirmRemotePublish,
              }, lock)
            : null;
          prev = readWatchState(p.id);
          const probe = await probeRemote(p, { prevProbe: prev?.auditedProbe, knownOwn: knownOwnCommits(prev) });
          const nextSignature = signatureOf(probe);
          recordObservation(root, p.id, 'cli', { signature: nextSignature, probe }, lock);
          const classification = classifyProbe({
            prevProbe: prev?.auditedProbe || null,
            nextProbe: probe,
            knownOwn: knownOwnCommits(prev),
            projectId: p.id,
          });
          if (classification.unknown) throw new Error(classification.reason);
          let decision;
          if (!flags.fresh && classification.ownOnly) {
            decision = { refresh: fullEvery > 0 && tickCount % fullEvery === 0, real: false, reason: classification.reason, ownOnly: true };
          } else {
            decision = decideRefresh({
              prevSignature: prev?.auditedSignature ?? null,
              nextSignature, fresh: Boolean(flags.fresh), tickCount, fullEvery,
            });
          }
          if (reconciled?.status === 'confirmed' && !decision.real) decision.refresh = false;
          const consistency = auditConsistency(root, p.id, prev);
          let bundle = consistency.bundle;
          const pending = pendingDecision({ state: prev, hash: bundle?.hashes?.facts || null, allowPublish: doPublish });
          decision = applyAuditConsistency(decision, consistency);
          if (!decision.refresh && !pending.publish) {
            console.log(`[watch] ${p.id} ${decision.reason}，跳过（第${tickCount}轮）`);
            writeWatchState(p.id, { ...readWatchState(p.id), tickCount, failures: 0, lastError: null, lastRunAt: new Date().toISOString() });
            continue;
          }
          const willPublish = doPublish && (decision.real || pending.publish);
          const retryOnly = pending.publish && !pending.audit && !decision.refresh;
          if (!retryOnly) {
            console.log(`[watch] ${p.id} ${decision.reason} → 重算审计`);
            const audited = await auditOne(p, { fresh: true, lock });
            bundle = audited.bundle;
            recordAudit(root, p.id, 'cli', {
              hash: bundle.hashes.facts,
              signature: decision.unknown ? null : nextSignature,
              probe: decision.unknown ? null : probe,
              publish: willPublish,
            }, lock);
            if (interpret) {
              try {
                await watchOnce(p, root, { comment: doPublish });
              } catch (err) {
                console.error(`[watch] ${p.id} 提交解读失败（不影响审计）: ${String(err.message).slice(0, 160)}`);
              }
            }
          }
          let published = prev?.lastPublished || null;
          if (willPublish) {
            const result = await publishWithRetry(root, p, bundle, readWatchState(p.id)?.pendingPublish?.signature ?? null, console.log, lock);
            ({ bundle, ...published } = result);
            failures = published.status === 'error' ? failures + 1 : 0;
          } else {
            failures = 0;
          }
          worst = Math.max(worst, failures);
          const s = bundle.facts.stats;
          writeWatchState(p.id, {
            ...readWatchState(p.id), tickCount, failures,
            lastError: failures ? published.error : null,
            lastRunAt: new Date().toISOString(), lastPublished: published,
          });
          console.log(
            `[watch] ${p.id} 完成 ${s.done}/${s.nodes} | 停滞 ${s.stale} 阻塞 ${s.blocked} 待启动 ${s.ready} | ${bundle.hashes.facts.slice(7, 15)}${willPublish ? ' | 写回 ' + published.label : ''}`,
          );
        } catch (err) {
          failures += 1;
          worst = Math.max(worst, failures);
          try {
            assertProjectLock(root, p.id, lock);
            writeWatchState(p.id, { ...readWatchState(p.id), tickCount, failures, lastError: String(err.message).slice(0, 200), lastRunAt: new Date().toISOString() });
          } catch {}
          console.error(`[watch] ${p.id} 失败(连续${failures}): ${String(err.message).slice(0, 200)}`);
        } finally {
          releaseProjectLock(lock);
        }
      }
      return worst;
    };

    if (flags.once) {
      process.exitCode = (await tick()) > 0 ? 1 : 0;
    } else {
      console.log(
        `[watch] 每 ${interval / 60000} 分钟检查一次，无变化跳过、每 ${fullEvery} 轮兜底全量${doPublish ? '，--publish 真变化时写回' : ''}${interpret ? '' : '，已关提交解读'}。Ctrl+C 退出`,
      );
      // setTimeout 链：下一轮只在本轮跑完后才排程，天然不重叠（不用 setInterval）。
      const loop = async () => {
        const worst = await tick();
        const delay = backoffDelay(interval, worst);
        if (worst > 0) console.log(`[watch] 有失败，退避 ${(delay / 60000).toFixed(1)} 分钟后重试`);
        setTimeout(loop, delay);
      };
      await loop();
    }
  } else if (cmd === 'issues') {
    const p = pickProject(root, rest[0]);
    const dir = join(root, 'projects', p.id, 'issues');
    const cmds = [];
    const bodies = [];
    for (const n of p.plan.nodes) {
      const m = p.members?.[n.owner];
      const body = [
        `# [PM] ${n.id} · ${n.title}`,
        '',
        pmStamp({ kind: '任务卡', project: p, asOf: new Date().toISOString() }),
        '',
        `任务节点 **${n.id}** ｜ 负责人 ${n.owner}（${m?.name || ''}）｜ 工期 ${n.est}`,
        '',
        `**依赖**：${n.deps.length ? n.deps.join('、') : '无'}`,
        '',
        `**涉及文件**：${(n.files || []).join('、') || '—'}`,
        '',
        `**验收标准**：${n.acceptance || '—'}`,
        '',
        '**完成条件**：合并的 PR 里写 `Closes #<本issue>`，或直接关闭本 issue。',
        '',
        `<!-- pm:node=${n.id} -->`,
        pmFooter(),
      ].join('\n');
      cmds.push(`gh issue create --repo ${p.repo} --title "[PM] [${n.id}] ${n.title.replace(/"/g, "'")}"${m?.github ? ` --assignee ${m.github}` : ''} --body-file projects/${p.id}/issues/${n.id}.md`);
      bodies.push({ name: `${n.id}.md`, body });
    }
    await withProjectLockWrite(root, p.id, () => {
      mkdirSync(dir, { recursive: true });
      for (const item of bodies) writeAtomicFile(join(dir, item.name), item.body);
    });
    console.log(`已生成 ${p.plan.nodes.length} 份 issue 正文到 projects/${p.id}/issues/\n`);
    console.log(cmds.join('\n'));
  } else if (cmd === 'sync') {
    const ids = flags.all || !rest[0] ? listProjects(root).map((p) => p.id) : [rest[0]];
    for (const id of ids) {
      const p = getProject(root, id);
      const r = await syncFromRemote(root, p);
      if (r.status === 'absent') console.log(`[${id}] 远端还没有 PM 数据包`);
      else if (r.status === 'same') console.log(`[${id}] 已是最新 ${r.hash.slice(7, 15)}`);
      else if (r.status === 'updated') console.log(`[${id}] 已读取远端更新 ${r.hash.slice(7, 15)}（基准 ${r.asOf}）`);
      else if (r.status === 'untrusted') console.log(`[${id}] 拒绝加载：远端数据包最后提交者 ${r.author || '未知'} 不是管理员 ${r.expectedAdmin}`);
      else if (r.status === 'invalid') console.log(`[${id}] 远端数据包校验失败${r.reason ? `（${r.reason}）` : ''}：${r.error || `${r.actual} ≠ ${r.expected}`}`);
      else console.log(`[${id}] 同步返回未知状态：${JSON.stringify(r)}`);
    }
  } else if (cmd === 'publish') {
    const ids = flags.all || !rest[0] ? listProjects(root).map((p) => p.id) : [rest[0]];
    for (const id of ids) {
      const p = getProject(root, id);
      const r = await withProjectLockWrite(root, id, () => {
        const bundle = loadBundle(root, id);
        if (!bundle) throw new Error(`${id} 还没有审计数据，先跑 pmctl audit ${id}`);
        return publishBundle(root, p, bundle);
      });
      if (r.status === 'same') console.log(`[${id}] 远端已是最新 ${r.hash.slice(7, 15)}`);
      else console.log(`[${id}] 已发布 ${r.changed} 个文件 → ${r.commit.slice(0, 8)}（${r.hash.slice(7, 15)}）`);
    }
  } else if (cmd === 'agent') {
    const p = pickProject(root, rest[0]);
    const bundle = loadBundle(root, p.id);
    if (!bundle) throw new Error(`${p.id} 还没有审计数据`);
    const identity = detectIdentity(p);
    const agent = buildAgent(p, bundle, identity);
    await withProjectLockWrite(root, p.id, () => writeAgentLocal(root, p, bundle, identity));
    if (flags.json) {
      console.log(JSON.stringify(agent.index, null, 2));
    } else {
      console.log(`身份：${identityLabel(identity)}`);
      console.log(`数据基准：${bundle.asOf} ｜ 指纹 ${bundle.hashes.facts.slice(7, 15)}`);
      console.log(`本机负责节点：${agent.index.identity.ownedNodes.join('、') || '无（或身份未匹配）'}`);
      console.log(`简报目录：data/${p.id}/agent/（index.json + tasks/*.md）`);
    }
  } else if (cmd === 'plan-draft') {
    const apiConfig = resolveApiConfig(loadEnv(root));
    if (apiConfig.requiresKey && !apiConfig.key) {
      throw new Error('plan-draft 需要模型 key：在界面「API 设置」或 .env 配置（审计与写回不受影响）');
    }
    let repo;
    let branch = 'main';
    let localRepo = null;
    let id = null;
    let members = null;
    let out;
    if (rest[0]) {
      const p = getProject(root, rest[0]);
      repo = p.repo;
      branch = p.defaultBranch || 'main';
      localRepo = p.localRepo;
      id = p.id;
      members = p.members;
      out = join(p.dir, 'plan.draft.json');
    } else if (flags.repo) {
      repo = flags.repo;
      branch = flags.branch || 'main';
      localRepo = flags.local || null;
      out = join(root, 'tmp', `plan-draft-${repo.replace('/', '-')}.json`);
    } else {
      throw new Error('用法: pmctl plan-draft <id> 或 --repo owner/name [--local 路径] [--branch main] [--out 路径]');
    }
    if (flags.out) out = flags.out;
    const r = await planDraft(root, { repo, branch, localRepo, id, members, log: console.log });
    const writeDraft = () => {
      mkdirSync(dirname(out), { recursive: true });
      writeAtomicFile(out, JSON.stringify(r.plan, null, 2));
    };
    if (id) await withProjectLockWrite(root, id, writeDraft);
    else writeDraft();
    console.log(`草稿 ${r.plan.nodes.length} 个节点（模型第 ${r.attempts} 版通过校验）→ ${out}`);
    console.log('这是草稿：人工逐条核对后，新项目用 project:add --plan 指向它，老项目自行合并进 plan.json；PM 不会覆盖正式计划。');
  } else if (cmd === 'onboard') {
    const p = pickProject(root, rest[0]);
    const bundle = loadBundle(root, p.id);
    if (!bundle) throw new Error(`${p.id} 还没有审计数据，先跑 pmctl audit ${p.id}`);
    const text = renderOnboarding(root, p, bundle, detectIdentity(p));
    const file = join(root, 'data', p.id, 'onboarding.md');
    await withProjectLockWrite(root, p.id, () => writeAtomicFile(file, text));
    console.log(text);
    console.error(`\n已存到 ${file} —— 把上面整段复制进 agent 会话即可开工`);
  } else if (cmd === 'trail') {
    const p = pickProject(root, rest[0]);
    const bundle = loadBundle(root, p.id);
    if (!bundle) throw new Error(`${p.id} 还没有审计数据，先跑 pmctl audit ${p.id}`);
    const check = verifyBundle(bundle);
    const file = join(root, 'data', p.id, 'trail.md');
    await withProjectLockWrite(root, p.id, () => writeAtomicFile(file, renderTrail(bundle, check)));
    console.log(`[${p.id}] 证据链：${check.ok ? '指纹重算一致 ✓' : `指纹不一致 ✗（${check.actual} ≠ ${check.expected}）`} ｜ 完成 ${bundle.facts.stats.done}/${bundle.facts.stats.nodes}`);
    console.log(file);
  } else if (cmd === 'alerts') {
    const p = pickProject(root, rest[0]);
    const bundle = loadBundle(root, p.id);
    if (!bundle) throw new Error(`${p.id} 还没有审计数据，先跑 pmctl audit ${p.id}`);
    const alerts = buildAlerts(bundle.facts, { staleDays: p.staleDays });
    const c = alertCounts(alerts);
    const dir = join(root, 'data', p.id);
    const md = renderAlerts(bundle.facts, alerts, { ...p, hash: bundle.hashes.facts });
    await withProjectLockWrite(root, p.id, () => {
      writeAtomicFile(join(dir, 'alerts.json'), JSON.stringify({ asOf: bundle.asOf, hash: bundle.hashes.facts, counts: c, alerts }, null, 2));
      writeAtomicFile(join(dir, 'alerts.md'), md);
    });
    console.log(md);
    console.error(`\n[${p.id}] 催办 ${c.total} 条（停滞 ${c.stale} ｜ 卡点 ${c.blocked} ｜ 待启动 ${c.ready}，关键路径 ${c.critical}）。已存到 ${join(dir, 'alerts.json')} / alerts.md。本机提醒，不会自动发 GitHub。`);
  } else if (cmd === 'link') {
    const p = pickProject(root, rest[0]);
    const node = String(flags.node || '').toUpperCase();
    const branch = String(flags.branch || '');
    if (!node || !branch) throw new Error('用法: pmctl link <id> --branch <分支> --node <节点> [--run]');
    const info = linkCommand(p, { node, branch });
    if (info.status === 'no-pr') {
      console.log(`分支 ${branch} 没有 open PR，无法自动归位`);
    } else {
      console.log(info.command);
      if (flags.run) {
        const r = await postNodeLink(p, { node, branch });
        console.log(`已评论 PR #${r.pr}`);
      }
    }
  } else if (cmd === 'unlock') {
    const id = rest[0];
    if (!id) throw new Error('用法: pmctl unlock <id>');
    const result = clearStaleProjectLock(root, id);
    if (result.status === 'cleared') {
      console.log(`已清除 ${id} 的死亡进程锁（pid ${result.owner.pid}）`);
    } else if (result.status === 'absent') {
      console.log(`${id} 没有项目锁`);
    } else {
      throw new Error(result.error || `无法解锁 ${id}：${result.status}`);
    }
  } else if (cmd === 'pr-note') {
    const p = pickProject(root, rest[0]);
    const bundle = loadBundle(root, p.id);
    if (!bundle) throw new Error(`${p.id} 还没有审计数据`);
    const pr = Number(flags.pr);
    if (!pr) throw new Error('用法: pmctl pr-note <id> --pr <编号>');
    const r = await postProgressNote(p, bundle, pr);
    console.log(r.status === 'updated' ? `已更新 PR #${pr} 的 PM 备注` : `已评论 PR #${pr}`);
  } else {
    console.log('用法: pmctl <list|audit|import|project:add|plan-draft|adopt|doctor|watch|issues|sync|publish|agent|onboard|trail|alerts|unlock|link|pr-note>');
    console.log('');
    console.log('watch（自动审计闭环）: pmctl watch [id|--all] [--interval 分钟] [--once] [--fresh] [--publish] [--no-interpret] [--full-every N]');
    console.log('  默认每 10 分钟廉价探针远端，有变化才全量重算 facts/翻转状态/刷新 trail+本机催办+简报；无变化跳过，每 6 轮兜底全量。');
    console.log('  --publish 仅在远端真有变化时写回（单写者，冲突自动 sync 重试一次）；催办始终本机，不外发。--once 只跑一轮。');
  }
} catch (err) {
  console.error(`错误: ${err.message}`);
  process.exitCode = err.code === 'BUSY' ? 70 : 1;
}
