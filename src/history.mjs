import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicFile } from './project-lock.mjs';

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
  writeAtomicFile(historyPath(root, id), JSON.stringify(trimmed, null, 2) + '\n');
  return trimmed;
}
