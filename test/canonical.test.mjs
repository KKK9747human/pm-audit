import test from 'node:test';
import assert from 'node:assert/strict';
import { stable, hashOf } from '../src/canonical.mjs';

test('stable 按 key 排序并丢弃 undefined', () => {
  assert.equal(stable({ b: 1, a: undefined, c: null }), '{"b":1,"c":null}');
});

test('stable 保持数组顺序', () => {
  assert.equal(stable([3, 1, 2]), '[3,1,2]');
});

test('stable 处理非法数字为 null', () => {
  assert.equal(stable(Number.NaN), 'null');
});

test('hashOf 与 key 顺序无关', () => {
  assert.equal(hashOf({ a: 1, b: [2, 3] }), hashOf({ b: [2, 3], a: 1 }));
});

test('hashOf 值变化会改变指纹', () => {
  assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
});

test('hashOf 带 sha256 前缀', () => {
  assert.match(hashOf({}), /^sha256:[0-9a-f]{64}$/);
});
