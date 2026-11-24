import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const API_PROVIDERS = [
  { id: 'longcat', label: 'LongCat', baseUrl: 'https://api.longcat.chat/openai/v1', model: 'LongCat-2.5', requiresKey: true },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', requiresKey: true },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', requiresKey: true },
  { id: 'ollama', label: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', requiresKey: false },
  { id: 'custom', label: '自定义', baseUrl: '', model: '', requiresKey: true },
];

const providerMap = new Map(API_PROVIDERS.map((provider) => [provider.id, provider]));
const managedKeys = /^(PM_API_PROVIDER|PM_API_BASE|PM_API_MODEL|PM_API_KEY|LONGCAT_API_KEY|LONGCAT_BASE|LONGCAT_MODEL)\s*=/;
const clean = (value) => String(value || '').trim();

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

export function normalizeBaseUrl(value) {
  const base = clean(value).replace(/\/+$/, '');
  if (!base) return '';
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error('Base URL 格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Base URL 只支持 HTTP 或 HTTPS');
  if (url.username || url.password) throw new Error('Base URL 不能包含账号或密码');
  return base;
}

function inferProvider(base) {
  const normalized = normalizeBaseUrl(base);
  return API_PROVIDERS.find((provider) => provider.baseUrl && normalizeBaseUrl(provider.baseUrl) === normalized)?.id || 'longcat';
}

export function resolveApiConfig(env = {}) {
  const hasGeneric = ['PM_API_PROVIDER', 'PM_API_BASE', 'PM_API_MODEL', 'PM_API_KEY'].some((key) => env[key] !== undefined);
  const requested = clean(env.PM_API_PROVIDER) || inferProvider(clean(env.PM_API_BASE || (!hasGeneric ? env.LONGCAT_BASE : '')));
  const provider = providerMap.has(requested) ? requested : 'custom';
  const preset = providerMap.get(provider);
  return {
    provider,
    baseUrl: normalizeBaseUrl(env.PM_API_BASE || (!hasGeneric ? env.LONGCAT_BASE : '') || preset.baseUrl),
    model: clean(env.PM_API_MODEL || (!hasGeneric ? env.LONGCAT_MODEL : '') || preset.model),
    key: clean(env.PM_API_KEY || (!hasGeneric ? env.LONGCAT_API_KEY : '')),
    requiresKey: preset.requiresKey,
  };
}

export function apiSettingsView(config) {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: Boolean(config.key),
    hint: config.key ? config.key.slice(-4) : '',
    requiresKey: config.requiresKey,
    providers: API_PROVIDERS.map(({ id, label, baseUrl, model, requiresKey }) => ({ id, label, baseUrl, model, requiresKey })),
  };
}

export function saveApiConfig(root, input) {
  const current = resolveApiConfig(loadEnv(root));
  const provider = clean(input.provider) || current.provider;
  if (!providerMap.has(provider)) throw new Error('未知的 API 服务商');
  const preset = providerMap.get(provider);
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? preset.baseUrl);
  if (!baseUrl) throw new Error('请填写 Base URL');
  const model = clean(input.model ?? preset.model);
  if (!model) throw new Error('请填写模型名');
  const sameEndpoint = provider === current.provider && baseUrl === current.baseUrl;
  const key = clean(input.apiKey) || (sameEndpoint ? current.key : '');
  if (preset.requiresKey && !key) throw new Error('这个服务需要 API key');

  const file = join(root, '.env');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const kept = text.split(/\r?\n/).filter((line) => !managedKeys.test(line.trim()));
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const values = { PM_API_PROVIDER: provider, PM_API_BASE: baseUrl, PM_API_MODEL: model, PM_API_KEY: key };
  const output = [...kept, ...Object.entries(values).map(([name, value]) => `${name}=${value}`), ''].join('\n');
  writeFileSync(file, output, { encoding: 'utf8', mode: 0o600 });
  return resolveApiConfig(loadEnv(root));
}

export async function complete(root, messages, { temperature = 0.3, maxTokens = 1600 } = {}) {
  const config = resolveApiConfig(loadEnv(root));
  if (config.requiresKey && !config.key) throw new Error('未配置 API key');
  const headers = { 'Content-Type': 'application/json' };
  if (config.key) headers.Authorization = `Bearer ${config.key}`;
  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: config.model, temperature, max_tokens: maxTokens, stream: false, messages }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`模型返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}
