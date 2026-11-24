import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  API_PROVIDERS,
  apiSettingsView,
  complete,
  loadEnv,
  normalizeBaseUrl,
  resolveApiConfig,
  saveApiConfig,
} from '../src/llm.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'pm-api-config-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('旧 LONGCAT 配置继续生效', () => fixture((root) => {
  writeFileSync(join(root, '.env'), 'LONGCAT_API_KEY=secret-1234\nLONGCAT_BASE=https://api.longcat.chat/openai/v1/\nLONGCAT_MODEL=LongCat-2.5\n');
  const config = resolveApiConfig(loadEnv(root));
  assert.equal(config.provider, 'longcat');
  assert.equal(config.baseUrl, 'https://api.longcat.chat/openai/v1');
  assert.equal(config.model, 'LongCat-2.5');
  assert.equal(config.key, 'secret-1234');
}));

test('新 PM_API 配置优先且不把旧 key 带到其他服务商', () => {
  const config = resolveApiConfig({
    PM_API_PROVIDER: 'openai',
    PM_API_BASE: 'https://api.openai.com/v1',
    PM_API_MODEL: 'gpt-4o-mini',
    LONGCAT_API_KEY: 'old-secret',
  });
  assert.equal(config.provider, 'openai');
  assert.equal(config.key, '');
  assert.equal(config.requiresKey, true);
});

test('设置响应只返回 key 尾号，不返回完整密钥', () => {
  const view = apiSettingsView(resolveApiConfig({ PM_API_PROVIDER: 'deepseek', PM_API_KEY: 'secret-abcdef' }));
  assert.equal(view.hasKey, true);
  assert.equal(view.hint, 'cdef');
  assert.equal(view.providers.length, API_PROVIDERS.length);
  assert.equal(JSON.stringify(view).includes('secret-abcdef'), false);
});

test('保存配置会迁移旧变量并保留无关设置', () => fixture((root) => {
  const file = join(root, '.env');
  writeFileSync(file, '# local\nLONGCAT_API_KEY=secret-1234\nLONGCAT_BASE=https://api.longcat.chat/openai/v1\nLONGCAT_MODEL=LongCat-2.5\nPM_PORT=7317\n');
  const config = saveApiConfig(root, { provider: 'longcat', baseUrl: 'https://api.longcat.chat/openai/v1', model: 'LongCat-2.5-Preview' });
  assert.equal(config.key, 'secret-1234');
  assert.equal(config.model, 'LongCat-2.5-Preview');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /PM_API_PROVIDER=longcat/);
  assert.match(text, /PM_PORT=7317/);
  assert.doesNotMatch(text, /^LONGCAT_/m);
}));

test('更换服务商或地址时不会沿用旧密钥', () => fixture((root) => {
  const file = join(root, '.env');
  writeFileSync(file, 'LONGCAT_API_KEY=secret-1234\nLONGCAT_BASE=https://api.longcat.chat/openai/v1\nLONGCAT_MODEL=LongCat-2.5\n');
  assert.throws(() => saveApiConfig(root, { provider: 'openai' }), /需要 API key/);
  assert.throws(() => saveApiConfig(root, { provider: 'custom', baseUrl: 'https://example.invalid/v1', model: 'x' }), /需要 API key/);
  assert.equal(readFileSync(file, 'utf8').includes('PM_API_PROVIDER=openai'), false);
}));

test('Ollama 无需密钥，非法地址会被拒绝', () => fixture((root) => {
  const config = saveApiConfig(root, { provider: 'ollama' });
  assert.equal(config.provider, 'ollama');
  assert.equal(config.key, '');
  assert.equal(config.requiresKey, false);
  assert.throws(() => normalizeBaseUrl('file:///tmp/model'), /HTTP 或 HTTPS/);
  assert.throws(() => normalizeBaseUrl('https://user:pass@example.invalid/v1'), /账号或密码/);
}));

test('complete 按所选服务发送 OpenAI 兼容请求', async () => fixture(async (root) => {
  writeFileSync(join(root, '.env'), 'PM_API_PROVIDER=custom\nPM_API_BASE=https://example.invalid/v1/\nPM_API_MODEL=demo-model\nPM_API_KEY=secret-1234\n');
  const originalFetch = globalThis.fetch;
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  try {
    assert.equal(await complete(root, [{ role: 'user', content: 'hi' }]), 'ok');
    assert.equal(call.url, 'https://example.invalid/v1/chat/completions');
    assert.equal(call.options.headers.Authorization, 'Bearer secret-1234');
    assert.equal(JSON.parse(call.options.body).model, 'demo-model');
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

test('Ollama 请求不发送空 Authorization', async () => fixture(async (root) => {
  writeFileSync(join(root, '.env'), 'PM_API_PROVIDER=ollama\nPM_API_BASE=http://127.0.0.1:11434/v1\nPM_API_MODEL=qwen2.5:7b\nPM_API_KEY=\n');
  const originalFetch = globalThis.fetch;
  let headers;
  globalThis.fetch = async (_url, options) => {
    headers = options.headers;
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  try {
    await complete(root, [{ role: 'user', content: 'hi' }]);
    assert.equal(Object.hasOwn(headers, 'Authorization'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}));
