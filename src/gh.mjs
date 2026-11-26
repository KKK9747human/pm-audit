import { execFileSync, spawn } from 'node:child_process';

const sleep = (ms, { signal } = {}) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

function ghRun(args, { input, timeout = 120000, signal } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    let stopped = false;
    let stopReason;
    const stop = (reason) => {
      if (settled || stopped) return;
      stopped = true;
      stopReason = reason;
      clearTimeout(timer);
      child.kill();
    };
    const abort = () => stop(signal.reason);
    const timer = setTimeout(() => stop(Object.assign(new Error(`gh 请求超时（${timeout}ms）`), {
      code: 'GH_TIMEOUT',
    })), timeout);
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (error) => {
      if (settled) return;
      cleanup();
      reject(stopped ? stopReason : error);
    });
    child.on('close', (code) => {
      if (settled) return;
      cleanup();
      if (stopped) reject(stopReason);
      else if (code === 0) resolve(out);
      else reject(Object.assign(new Error((err || out || `gh exited ${code}`).slice(0, 400)), { stdout: out }));
    });
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(input || '');
  });
}

export async function ghJson(path, { method = 'GET', body, retries = 4, timeout = 120000, signal } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
    try {
      const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json'];
      if (body !== undefined) args.push('--input', '-');
      const raw = await ghRun(args, {
        input: body === undefined ? '' : JSON.stringify(body),
        timeout, signal,
      });
      signal?.throwIfAborted();
      return raw.trim() ? JSON.parse(raw) : null;
    } catch (err) {
      signal?.throwIfAborted();
      // gh exits nonzero for GraphQL error envelopes, including partial data.
      if (path === 'graphql' && err?.stdout) {
        let response;
        try { response = JSON.parse(err.stdout); } catch {}
        if (Array.isArray(response?.errors) && response.errors.length) return response;
      }
      lastErr = err;
      if (attempt === retries) break;
      await sleep(2000 * attempt, { signal });
    }
  }
  const error = new Error(`gh ${method} ${path} 失败: ${String(lastErr?.message).slice(0, 300)}`);
  if (lastErr?.code) error.code = lastErr.code;
  throw error;
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
