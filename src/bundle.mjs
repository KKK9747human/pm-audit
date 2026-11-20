import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashOf } from './canonical.mjs';
import { buildFacts } from './facts.mjs';

export const FORMAT = 'pm-audit/bundle';
export const VERSION = 1;

export function normalizeEvidence(raw) {
  return {
    repo: raw.repo,
    fetchedAt: raw.fetchedAt,
    issues: [...raw.issues].sort((a, b) => a.number - b.number),
    pulls: [...raw.pulls].sort((a, b) => a.number - b.number),
    branches: [...raw.branches].sort((a, b) => a.name.localeCompare(b.name)),
    branchCommits: [...raw.branchCommits]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => ({ ...b, commits: [...b.commits].sort((x, y) => x.sha.localeCompare(y.sha)) })),
    pullDetails: raw.pullDetails,
  };
}

export function buildBundle(project, raw, facts) {
  const body = {
    format: FORMAT,
    version: VERSION,
    project: {
      id: project.id,
      name: project.name,
      repo: project.repo,
      defaultBranch: project.defaultBranch,
      admin: project.admin || null,
      members: project.members,
      planSource: project.planSource || '',
      commitWindowDays: project.commitWindowDays,
      staleDays: project.staleDays,
      activeWindowDays: project.activeWindowDays,
    },
    asOf: facts.asOf,
    plan: project.plan,
    evidence: normalizeEvidence(raw),
    facts,
  };
  body.hashes = {
    plan: hashOf(body.plan),
    evidence: hashOf(body.evidence),
    facts: hashOf(body.facts),
  };
  return body;
}

export function verifyBundle(bundle) {
  if (bundle?.format !== FORMAT) throw new Error(`不是 ${FORMAT} 数据包`);
  if (bundle.version !== VERSION) throw new Error(`版本不支持: ${bundle.version}`);
  const cfg = { ...bundle.project, id: bundle.project.id };
  const facts = buildFacts(bundle.plan, bundle.evidence, cfg, bundle.asOf);
  const actual = hashOf(facts);
  const declared = hashOf(bundle.facts);
  return {
    ok: actual === bundle.hashes?.facts && declared === bundle.hashes?.facts,
    expected: bundle.hashes?.facts,
    actual,
    facts,
  };
}

export function saveBundle(root, bundle) {
  const dir = join(root, 'data', bundle.project.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bundle.pm.json'), JSON.stringify(bundle, null, 2), 'utf8');
  return join(dir, 'bundle.pm.json');
}

export function loadBundle(root, id) {
  const file = join(root, 'data', id, 'bundle.pm.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function listBundles(root) {
  const dir = join(root, 'data');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const id of readdirSync(dir)) {
    const b = loadBundle(root, id);
    if (b) out.push(b);
  }
  return out;
}
