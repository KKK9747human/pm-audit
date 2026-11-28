import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTls } from '../src/tls.mjs';

test('没配证书时返回 null（本机默认明文 HTTP）', () => {
  assert.equal(resolveTls({}), null);
  assert.equal(resolveTls({ PM_TLS_CERT: 'only-cert.pem' }), null);
  assert.equal(resolveTls({ PM_TLS_KEY: 'only-key.pem' }), null);
  assert.equal(resolveTls({ PM_TLS_CERT_PEM: 'cert' }), null);
});

test('给了 PEM 内容就直接用', () => {
  const tls = resolveTls({ PM_TLS_CERT_PEM: 'CERT', PM_TLS_KEY_PEM: 'KEY' });
  assert.deepEqual(tls, { cert: 'CERT', key: 'KEY' });
});

test('给了证书路径就读文件内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-tls-'));
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  writeFileSync(cert, 'CERT-BYTES');
  writeFileSync(key, 'KEY-BYTES');
  const tls = resolveTls({ PM_TLS_CERT: cert, PM_TLS_KEY: key });
  assert.equal(String(tls.cert), 'CERT-BYTES');
  assert.equal(String(tls.key), 'KEY-BYTES');
});

test('证书文件读不到时报错，不静默降级成明文', () => {
  assert.throws(
    () => resolveTls({ PM_TLS_CERT: 'C:/definitely-missing-cert.pem', PM_TLS_KEY: 'C:/definitely-missing-key.pem' }),
    /读取 TLS 证书失败/,
  );
});
