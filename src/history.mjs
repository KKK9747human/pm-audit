import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX = 100;

function historyPath(root, id) {
  return join(root, 'data', id, 'brief-history.json');
}

export function loadBriefHistory(root, id) {
  const path = historyPath(root, id);
  if (!existsSync(path)) return [];
  try {
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.hash === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberBriefing(root, id, bundle) {
  const rows = loadBriefHistory(root, id);
  if (rows.some((r) => r.hash === bundle.hashes.facts)) return rows;
  rows.push({
    hash: bundle.hashes.facts,
    asOf: bundle.asOf,
    plan: bundle.hashes.plan,
    at: new Date().toISOString(),
  });
  const trimmed = rows.slice(-MAX);
  mkdirSync(join(root, 'data', id), { recursive: true });
  writeFileSync(historyPath(root, id), JSON.stringify(trimmed, null, 2) + '\n', 'utf8');
  return trimmed;
}
