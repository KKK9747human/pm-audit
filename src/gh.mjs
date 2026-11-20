import { execFileSync, spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ghRun(args, { input, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err || out || `gh exited ${code}`).slice(0, 400)));
    });
    child.stdin.end(input || '');
  });
}

export async function ghJson(path, { method = 'GET', body, retries = 4, timeout = 120000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json'];
      if (body !== undefined) args.push('--input', '-');
      const raw = await ghRun(args, {
        input: body === undefined ? '' : JSON.stringify(body),
        timeout,
      });
      return raw.trim() ? JSON.parse(raw) : null;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await sleep(2000 * attempt);
    }
  }
  throw new Error(`gh ${method} ${path} 失败: ${String(lastErr?.message).slice(0, 300)}`);
}

export async function ghApi(path, { pages = 1, perPage = 100, retries = 5 } = {}) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${path}${sep}per_page=${perPage}&page=${page}`;
    let data;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const raw = execFileSync('gh', ['api', url], {
          encoding: 'utf8',
          maxBuffer: 128 * 1024 * 1024,
          timeout: 120000,
        });
        data = JSON.parse(raw);
        break;
      } catch (err) {
        if (attempt === retries) {
          throw new Error(`gh api ${url} 失败: ${String(err.message).slice(0, 300)}`);
        }
        await sleep(2000 * attempt);
      }
    }
    if (!Array.isArray(data)) return data;
    out.push(...data);
    if (data.length < perPage) break;
  }
  return out;
}
