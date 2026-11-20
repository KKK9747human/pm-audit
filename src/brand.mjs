import { hashOf } from './canonical.mjs';

export const PM = 'PM';

export function shortHash(hash) {
  return String(hash || '').replace(/^sha256:/, '').slice(0, 8);
}

export function pmStamp({ kind = '审计', project, asOf, hash } = {}) {
  const bits = ['**PM**', kind];
  if (project) bits.push(typeof project === 'string' ? project : project.name || project.id);
  if (asOf) bits.push(`基准 ${new Date(asOf).toISOString().slice(0, 16).replace('T', ' ')}`);
  if (hash) bits.push(`指纹 ${shortHash(hash)}`);
  return `> ${bits.join(' · ')}`;
}

export function pmFooter() {
  return '\n---\n*本内容由 PM 自动生成，不代表人工确认。*\n';
}

export function pmNote(text) {
  return `<!-- pm:generated="PM" -->\n${text}`;
}

export function fileHash(content) {
  return hashOf(String(content));
}
