import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnv(root) {
  try {
    const text = readFileSync(join(root, '.env'), 'utf8');
    const out = {};
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

export async function complete(root, messages, { temperature = 0.3, maxTokens = 1600 } = {}) {
  const env = loadEnv(root);
  const key = env.LONGCAT_API_KEY;
  if (!key) throw new Error('未配置 API key');
  const base = env.LONGCAT_BASE || 'https://api.longcat.chat/openai/v1';
  const model = env.LONGCAT_MODEL || 'LongCat-2.5';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature, max_tokens: maxTokens, stream: false, messages }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`模型返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}
