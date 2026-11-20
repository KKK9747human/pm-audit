import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdmin, adminDenied, identityLabel, adminList } from '../src/identity.mjs';

test('isAdmin 忽略大小写和空白', () => {
  assert.equal(isAdmin({ admin: ' Octo ' }, { login: 'OCTO' }), true);
  assert.equal(isAdmin({ admin: 'octo' }, { login: 'other' }), false);
});

test('未配置管理员或未登录时一律只读', () => {
  assert.equal(isAdmin({ admin: null }, { login: 'octo' }), false);
  assert.equal(isAdmin({ admin: 'octo' }, { login: null }), false);
  assert.equal(isAdmin(null, { login: 'octo' }), false);
});

test('adminDenied 说明本机身份与管理员', () => {
  const msg = adminDenied({ admin: 'octo' }, { login: 'someone' });
  assert.match(msg, /只读模式/);
  assert.match(msg, /someone/);
  assert.match(msg, /octo/);
});

test('绑定了 github 的成员自动成为管理员', () => {
  const project = {
    admin: 'lead',
    members: { A: { github: 'aaa' }, B: { github: null }, C: { github: 'CCC' } },
  };
  assert.equal(isAdmin(project, { login: 'AAA' }), true);
  assert.equal(isAdmin(project, { login: 'ccc' }), true);
  assert.equal(isAdmin(project, { login: 'lead' }), true);
  assert.equal(isAdmin(project, { login: 'unbound' }), false);
  const admins = adminList(project).map((v) => v.toLowerCase());
  assert.deepEqual(admins.sort(), ['aaa', 'ccc', 'lead']);
});

test('admins 列表与 admin 去重，空值不产生管理员', () => {
  assert.deepEqual(adminList({ admin: 'a', admins: ['A', 'b'], members: {} }), ['a', 'b']);
  assert.deepEqual(adminList({ admin: null, members: { X: { github: null } } }), []);
  assert.equal(isAdmin({ admin: null, members: {} }, { login: 'a' }), false);
});

test('identityLabel 区分匹配与未匹配', () => {
  assert.match(identityLabel({ login: 'octo', memberId: 'm1', memberName: 'One' }), /m1/);
  assert.match(identityLabel({ login: 'octo' }), /未匹配/);
  assert.match(identityLabel(null), /未知身份/);
});
