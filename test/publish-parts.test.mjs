import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { splitBundleParts } from '../src/remote.mjs';

test('分片按 48000 字符切分且可无损拼回', () => {
  const payload = randomBytes(60000);
  const b64 = gzipSync(payload, { level: 9 }).toString('base64');
  const parts = splitBundleParts(b64);
  assert.ok(parts.length > 1, '大包应拆成多片');
  for (const p of parts) {
    assert.ok(p.length <= 48000);
    assert.match(p, /^[A-Za-z0-9+/=]+$/);
  }
  const joined = parts.join('');
  assert.equal(joined, b64);
  assert.deepEqual(gunzipSync(Buffer.from(joined.replace(/\s/g, ''), 'base64')), payload);
});

test('小包只有一片', () => {
  const b64 = Buffer.from('small').toString('base64');
  assert.deepEqual(splitBundleParts(b64), [b64]);
});
