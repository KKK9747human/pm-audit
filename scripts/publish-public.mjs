// 把「工具子集」同步到公开仓库的工作副本。
//
// 本地仓库是全量的（含队内文档、参赛材料、真实项目数据），公开仓库只放工具本体。
// 以前这一步是手工拷贝，容易漏文件、也容易把不该公开的东西带上去；这里固定成白名单 + 扫描。
//
// 用法：
//   node scripts/publish-public.mjs                    # 只同步到 out/public-repo 并报告差异
//   node scripts/publish-public.mjs --target <dir>     # 指定工作副本目录
//   node scripts/publish-public.mjs --push             # 同步后提交并推送（会推送到公开仓库）
//   node scripts/publish-public.mjs --push --exclude .github/
//
// `--exclude` 用来跳过某些路径（可重复，按路径前缀匹配）。GitHub 允许用缺 `workflow` scope
// 的凭据推送普通文件，但拒绝新增/修改 `.github/workflows/*`；没有带 scope 的凭据时用这个参数
// 先把其余内容推上去，workflow 另行处理。
//
// 推送前会做泄露扫描：
//   - 白名单外的路径（队内文档、真实项目数据、.env）一律不复制；
//   - 文件内容里出现本机项目用过的仓库名、管理员、成员 GitHub 登录名时中止；
//   - 出现疑似真实密钥（长随机串、私钥 PEM）时中止。
//
// 需要在公开文件里引用某处内容时，把该字符串逐行写进 tmp/publish-allow.txt（该目录不入库）。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const target = join(root, value('--target', join('out', 'public-repo')));
const doPush = flag('--push');
const excludes = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--exclude' && args[i + 1]) excludes.push(args[i + 1].replace(/[\\/]+$/, ''));
}

// 白名单：公开仓库里应该有的东西。目录整份带走，文件逐个点名。
const DIRS = ['bin', 'src', 'test', 'scripts', 'templates', 'public', '.github'];
const FILES = ['.env.example', '.gitignore', '.gitattributes', 'README.md', 'package.json', 'server.mjs'];
const EXTRA_FILES = [join('plan', 'example.plan.json')];

// 复制期排除：这些即使在白名单目录里也不带走。
const EXCLUDE_FROM_COPY = [
  join('scripts', 'build-demo.mjs'), // 依赖本机 data/ 与本机项目 id，不对外
];

// 出现即中止：说明白名单写错了，或者有人把队内文件挪进了白名单目录。
const FORBIDDEN_PATHS = [
  '.env', '使用说明.md', '新同学上手.md', 'HANDOVER.md',
  'docs', 'submission', 'demo', 'out', 'data', 'cache', 'projects', 'tmp', 'snapshots',
  join('plan', 'issues'),
];

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 本机项目用过的真实标识：从 projects/*/project.json 里推导，脚本本身不写死任何真实名字。
function localProjects() {
  const ids = new Set();
  const identities = new Set();
  const dir = join(root, 'projects');
  if (!existsSync(dir)) return { ids, identities };
  for (const id of readdirSync(dir)) {
    const file = join(dir, id, 'project.json');
    if (!existsSync(file)) continue;
    ids.add(String(id));
    try {
      const p = JSON.parse(readFileSync(file, 'utf8'));
      if (p.repo) identities.add(String(p.repo));
      if (p.admin) identities.add(String(p.admin));
      for (const a of p.admins || []) identities.add(String(a));
      for (const m of Object.values(p.members || {})) {
        if (m?.github) identities.add(String(m.github));
      }
    } catch {}
  }
  return { ids, identities };
}

function allowList() {
  const file = join(root, 'tmp', 'publish-allow.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const full = join(dir, name);
    const rel = relative(base, full).split(sep).join('/');
    if (EXCLUDE_FROM_COPY.some((p) => rel === p.split(sep).join('/'))) continue;
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(rel);
  }
  return out;
}

let files = [];
for (const dir of DIRS) {
  const full = join(root, dir);
  if (existsSync(full)) files.push(...walk(full, root));
}
for (const file of [...FILES, ...EXTRA_FILES]) {
  if (existsSync(join(root, file))) files.push(file.split(sep).join('/'));
}
if (excludes.length) {
  const before = files.length;
  files = files.filter((f) => !excludes.some((x) => f === x || f.startsWith(`${x}/`)));
  console.log(`按 --exclude 跳过 ${before - files.length} 个文件：${excludes.join('、')}`);
}
files.sort();

// —— 检查 1：黑名单路径 ——
const { ids: projectIds, identities: identitySet } = localProjects();
const forbiddenPaths = [
  ...FORBIDDEN_PATHS,
  ...[...projectIds].map((id) => `plan/${id}.plan.json`),
];
const badPaths = files.filter((f) => forbiddenPaths.some((p) => f === p || f.startsWith(`${p}/`)));
if (badPaths.length) {
  console.error('中止：待发布列表里出现了不该公开的路径：');
  for (const f of badPaths) console.error(`  ${f}`);
  process.exit(1);
}

// —— 检查 2：内容里的真实身份与疑似密钥 ——
const identities = [...identitySet, ...projectIds].filter((s) => s.length >= 3);
const allow = allowList();
const leaks = [];
for (const file of files) {
  const text = readFileSync(join(root, file), 'utf8');
  for (const identity of identities) {
    if (allow.some((a) => a && text.includes(a))) continue;
    if (!text.includes(identity)) continue;
    // 项目 id 只在独立成词时才算命中，避免误伤更长的标识符
    const hit = identity === file.split('/').pop() || new RegExp(`(?<![A-Za-z0-9])${escRe(identity)}(?![A-Za-z0-9])`).test(text);
    if (hit) leaks.push(`${file} 含有本机项目标识「${identity}」`);
  }
  const secret = /(?:API_KEY|TOKEN|SECRET)\s*=\s*["']?[A-Za-z0-9_-]{24,}/.exec(text);
  if (secret && !allow.some((a) => a && text.includes(a))) leaks.push(`${file} 疑似真实密钥：${secret[0].slice(0, 40)}`);
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) leaks.push(`${file} 含私钥 PEM`);
}
if (leaks.length) {
  console.error('中止：文件内容里出现了真实身份或疑似密钥：');
  for (const l of leaks) console.error(`  ${l}`);
  console.error('\n确认要公开的话，把对应字符串逐行写进 tmp/publish-allow.txt 后重跑。');
  process.exit(1);
}

// —— 同步到工作副本（保留目标目录里的 .git，不整目录重建） ——
const wanted = new Set(files);
mkdirSync(target, { recursive: true });
for (const file of files) {
  const to = join(target, file);
  mkdirSync(join(to, '..'), { recursive: true });
  cpSync(join(root, file), to);
}
// 清掉目标里不再属于白名单的陈旧文件（.git 除外）。
// 被 --exclude 排除的路径：远端本来就有的保留不动，本机之前拷进去的删掉，避免被误提交。
const isRepo = existsSync(join(target, '.git'));
const tracked = new Set();
if (isRepo) {
  try {
    for (const line of execFileSync('git', ['ls-files'], { cwd: target, encoding: 'utf8' }).split(/\r?\n/)) {
      if (line) tracked.add(line);
    }
  } catch {}
}
const isExcluded = (rel) => excludes.some((x) => rel === x || rel.startsWith(`${x}/`));
const stale = walk(target, target).filter((rel) => !wanted.has(rel) && !(isExcluded(rel) && tracked.has(rel)));
for (const rel of stale) rmSync(join(target, rel), { force: true });
// 被排除且远端没有的：删掉，否则会被 git add -A 带上
if (isRepo) {
  for (const rel of walk(target, target)) {
    if (isExcluded(rel) && !tracked.has(rel)) rmSync(join(target, rel), { force: true });
  }
}
console.log(`已同步 ${files.length} 个文件到 ${relative(root, target) || target}${stale.length ? `，清理 ${stale.length} 个陈旧文件` : ''}`);

if (!isRepo) {
  console.log('该目录不是 git 仓库，跳过差异比对与推送。');
  process.exit(0);
}

const git = (...args) => execFileSync('git', args, { cwd: target, encoding: 'utf8' }).trim();
const status = git('status', '--porcelain');
if (!status) {
  console.log('与公开仓库当前内容一致，没有需要提交的变化。');
} else {
  console.log('待提交的变化：');
  for (const line of status.split(/\r?\n/)) console.log(`  ${line}`);
}

if (!doPush) {
  console.log('\n加 --push 可以提交并推送（会推送到公开仓库，请确认后再执行）。');
  process.exit(0);
}

git('add', '-A');
try {
  git('commit', '-m', 'feat: 更新 PM 审计台工具本体（README/CI/前端拆分/TLS 支持）');
} catch {
  console.log('没有可提交的变化。');
}
git('push', 'origin', 'HEAD');
console.log('已推送到公开仓库。');
