import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = new URL('../public/', import.meta.url);
const html = readFileSync(new URL('index.html', publicDir), 'utf8');
const scriptSrcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
const jsDir = new URL('js/', publicDir);
const jsDirPath = fileURLToPath(jsDir);
const files = readdirSync(jsDir).filter((f) => f.endsWith('.js')).sort();

test('前端脚本已拆分为多个文件，index.html 按顺序全部声明', () => {
  assert.ok(files.length >= 10, `前端应拆成多个文件，实际 ${files.length} 个`);
  assert.equal(scriptSrcs.length, files.length, 'index.html 声明的脚本数应与 public/js 下的文件数一致');
  const declared = scriptSrcs.map((s) => s.split('?')[0].replace(/^\//, ''));
  assert.deepEqual(declared.slice().sort(), files.map((f) => `js/${f}`).sort(), '每个前端文件都必须在 index.html 里声明，且不能有未声明的孤儿文件');
});

test('没有单文件超过 1200 行（原 app.js 是 3183 行）', () => {
  for (const f of files) {
    const lines = readFileSync(join(jsDirPath, f), 'utf8').split(/\r?\n/).length;
    assert.ok(lines <= 1200, `${f} 有 ${lines} 行，超过 1200 行上限`);
  }
});

test('boot 脚本放在最后，事件绑定在其之前', () => {
  const last = scriptSrcs[scriptSrcs.length - 1].split('?')[0];
  assert.ok(last.endsWith('/js/boot.js'), `最后一个脚本应是 boot.js，实际 ${last}`);
  const eventsAt = scriptSrcs.findIndex((s) => s.includes('/js/events.js'));
  const bootAt = scriptSrcs.findIndex((s) => s.includes('/js/boot.js'));
  assert.ok(eventsAt >= 0 && eventsAt < bootAt, 'events.js 必须在 boot.js 之前加载');
});

test('拆分后的脚本仍是 classic script（没有 import/export）', () => {
  for (const f of files) {
    const text = readFileSync(join(jsDirPath, f), 'utf8');
    assert.doesNotMatch(text, /^\s*import\s+.*\s+from\s+/m, `${f} 不应含 ESM import`);
    assert.doesNotMatch(text, /^\s*export\s/m, `${f} 不应含 ESM export`);
  }
});
