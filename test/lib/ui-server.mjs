import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, extname } from 'node:path';
import { sampleProject, sampleRaw } from './fixture.mjs';
import { buildFacts } from '../../src/facts.mjs';
import { buildBundle, verifyBundle } from '../../src/bundle.mjs';
import { buildAgent } from '../../src/agent.mjs';
import { buildTrail, renderTrail } from '../../src/trail.mjs';
import { buildAlerts, alertCounts, renderAlerts } from '../../src/alerts.mjs';
import { buildNextActions } from '../../src/next-actions.mjs';
import { renderOnboarding } from '../../src/onboard.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const projects = ['fixture-a', 'fixture-b', 'fixture-empty', 'fixture-unbound'].map((id, index) => {
  const project = sampleProject({ id, name: `测试数据 ${['甲', '乙', '空项目', '未绑定'][index]}`, repo: `fixture/${id}` });
  if (id === 'fixture-empty') project.members = {};
  return project;
});
const identity = { login: 'fixture-reader', email: null, memberId: null };
const bundles = new Map(projects.slice(0, 2).map((project) => {
  const raw = sampleRaw();
  raw.repo.full_name = project.repo;
  raw.fetchedAt = '2026-11-20T10:00:00.000Z';
  raw.pulls[0].merged_at = '2026-11-17T00:00:00Z';
  raw.pulls[1].updated_at = '2026-11-19T00:00:00Z';
  const facts = buildFacts(project.plan, raw, project, raw.fetchedAt);
  return [project.id, buildBundle(project, raw, facts)];
}));
const hits = [];
let config = {};
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const bodyOf = async (req) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
};

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;
  try {
    if (path === '/__fixture' && req.method === 'POST') {
      config = await bodyOf(req);
      if (!config.preserveHits) hits.length = 0;
      return json(res, 200, { ok: true });
    }
    if (path === '/__fixture') return json(res, 200, { config, hits });
    const requestConfig = structuredClone(config);
    if (Array.isArray(config.delays?.[path])) requestConfig.delays[path] = config.delays[path].shift() || 0;
    const hit = { path, method: req.method, done: false };
    if (path.startsWith('/api/')) {
      hits.push(hit);
      res.once('finish', () => { hit.done = true; });
    }
    if (requestConfig.delays?.[path]) await new Promise((done) => setTimeout(done, requestConfig.delays[path]));
    if (requestConfig.errors?.[path]) return json(res, requestConfig.errors[path], { error: 'fixture-only simulated failure' });
    if (path === '/api/settings') return json(res, 200, { hasKey: false, model: 'Fixture (no model)', hint: '' });
    if (path === '/api/projects') return json(res, 200, projects.map((p) => {
      const b = bundles.get(p.id);
      return { ...p, identity, isAdmin: false, admin: 'fixture-admin', stats: b?.facts.stats || null,
        asOf: b?.asOf || null, critical: b?.facts.criticalPath || null, mineCount: 0 };
    }));
    const match = path.match(/^\/api\/projects\/([^/]+)(.*)$/);
    if (match) {
      const [, id, sub] = match;
      const project = projects.find((p) => p.id === id);
      if (!project) return json(res, 404, { error: 'fixture project missing' });
      let bundle = bundles.get(id);
      if (bundle && requestConfig.revisions?.[id]) {
        const plan = { ...project.plan, nodes: project.plan.nodes.map((node) => ({ ...node, title: `${node.title} ${requestConfig.revisions[id]}` })) };
        const revised = { ...project, plan };
        bundle = buildBundle(revised, bundle.evidence, buildFacts(plan, bundle.evidence, revised, bundle.asOf));
      }
      if (sub === '/sync') return json(res, 200, { status: bundle ? 'same' : 'absent', hash: bundle?.hashes.facts });
      if (sub === '/identity' && req.method === 'POST') {
        const body = await bodyOf(req);
        hit.body = body;
        if (!project.members[body.memberId] || !body.github) return json(res, 400, { error: 'fixture invalid member' });
        return json(res, 200, { ok: true, label: `${body.github} → ${body.memberId}` });
      }
      if (['/publish', '/pr-note', '/interpret'].includes(sub)) return json(res, 403, { error: 'fixture is read-only' });
      if (!bundle) return json(res, 404, { error: '还没有审计数据' });
      if (sub === '') return json(res, 200, { ...bundle, identity, isAdmin: false, admin: 'fixture-admin', briefHistory: [] });
      const agent = buildAgent(project, bundle, identity);
      if (sub === '/agent') return json(res, 200, { ...agent.index, guide: agent.guide });
      if (sub.startsWith('/agent/')) {
        const node = agent.index.nodes.find((n) => n.id === sub.slice(7));
        if (!node) return json(res, 404, { error: 'fixture node missing' });
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(agent.nodeMarkdown(node));
      }
      if (sub === '/onboarding') return json(res, 200, { text: renderOnboarding(root, project, bundle, identity) });
      if (sub === '/trail') {
        const check = verifyBundle(bundle);
        const verify = requestConfig.legacy ? { ok: false, code: 'LEGACY_BUNDLE', error: '数据包版本 1 已过期，请重新审计' }
          : requestConfig.mismatch ? { ok: false, expected: bundle.hashes.facts, actual: 'sha256:' + 'f'.repeat(64) }
            : { ok: check.ok, expected: check.expected, actual: check.actual };
        return json(res, 200, { trail: buildTrail(bundle), verify, markdown: renderTrail(bundle, verify) });
      }
      if (sub === '/alerts') {
        const alerts = buildAlerts(bundle.facts, project);
        return json(res, 200, { alerts, next: buildNextActions(bundle.facts, project), counts: alertCounts(alerts),
          markdown: renderAlerts(bundle.facts, alerts, { ...project, hash: bundle.hashes.facts }) });
      }
      if (sub === '/refresh') return json(res, 200, { ok: true, readOnly: true, hash: bundle.hashes.facts, sync: { status: 'same' } });
      return json(res, 404, { error: 'fixture endpoint not implemented' });
    }
    const file = path === '/' ? 'index.html' : path.slice(1);
    // 前端已拆成 public/js/*.js，按需放行这些静态文件
    const allowed = file === 'index.html' || file === 'style.css' || /^js\/[A-Za-z0-9._-]+\.js$/.test(file);
    if (!allowed) return json(res, 404, { error: 'fixture static file denied' });
    const data = await readFile(join(root, 'public', file));
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)];
    res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(0, '127.0.0.1', () => console.log(`FIXTURE_URL http://127.0.0.1:${server.address().port}`));
}
