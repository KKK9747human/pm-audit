const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { syncBuiltinESMExports } = require('node:module');

const root = process.env.PM_TEST_ROOT;
if (!root || path.dirname(__filename) !== root) throw new Error('fixture root required');
const control = () => JSON.parse(fs.readFileSync(path.join(root, 'control.json'), 'utf8'));
const realRenameSync = fs.renameSync;
fs.renameSync = (from, to) => {
  const result = realRenameSync(from, to);
  if (process.env.PM_CRASH_AFTER_BUNDLE && String(to).endsWith('bundle.pm.json')) {
    process.kill(process.pid, 'SIGKILL');
  }
  return result;
};
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-11-20T10:00:00.000Z'])); }
  static now() { return RealDate.parse('2026-11-20T10:00:00.000Z'); }
};
const record = (event) => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ pid: process.pid, ...event }) + '\n');
const revoke = () => {
  const lock = path.join(root, 'cache', 'demo', 'project.lock');
  const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
  fs.writeFileSync(lock, JSON.stringify({ ...owner, token: 'fixture-successor' }));
};
const deny = (name) => {
  record({ type: 'denied', name });
  throw new Error(`unexpected external I/O: ${name}`);
};
global.fetch = () => deny('fetch');
http.request = http.get = () => deny('http');
https.request = https.get = () => deny('https');
net.Socket.prototype.connect = () => deny('socket');

const execFile = cp.execFile;
cp.execFile = (command, args, opts, callback) => {
  if (command !== process.execPath || args[0] !== path.join(root, 'bin', 'pmctl.mjs')) return deny('execFile');
  const settings = control();
  const controller = settings.mode === 'abort' ? new AbortController() : null;
  const child = execFile(command, args, {
    ...opts, ...(settings.timeout ? { timeout: settings.timeout } : {}),
    ...(controller ? { signal: controller.signal } : {}),
  }, callback);
  const abortTimer = controller ? setTimeout(() => controller.abort(), 250) : null;
  record({ type: 'audit-start', child: child.pid });
  child.once('error', (error) => {
    record({ type: 'audit-error', child: child.pid, code: error.code });
    queueMicrotask(() => {
      const lock = path.join(root, 'cache', 'demo', 'project.lock');
      let busy = false;
      try {
        fs.closeSync(fs.openSync(lock, 'wx'));
        fs.unlinkSync(lock);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        busy = true;
      }
      record({ type: 'audit-error-boundary', busy });
    });
  });
  child.once('close', (code, signal) => {
    clearTimeout(abortTimer);
    const lock = path.join(root, 'cache', 'demo', 'project.lock');
    record({ type: 'audit-close', child: child.pid, code, signal, lockPresent: fs.existsSync(lock) });
  });
  return child;
};
cp.execFileSync = (command, args) => {
  record({ type: 'external-sync', command, args });
  if (command === 'git' && JSON.stringify(args) === JSON.stringify(['config', 'user.email'])) return 'fixture@example.invalid\n';
  if (command !== 'gh' || args[0] !== 'api') return deny('execFileSync');
  if (args[1] === 'user' && args[2] === '--jq' && args[3] === '.login') {
    if (control().mode === 'revoke-identity') revoke();
    return 'fixture-admin\n';
  }
  const endpoint = args[1].split('?')[0];
  if (endpoint === 'repos/fixture/never-contact') {
    const settings = control();
    if (settings.mode === 'error') {
      process.stderr.write('fixture external failure\n');
      process.exit(23);
    }
    if (settings.mode === 'timeout' || settings.mode === 'abort') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    return JSON.stringify({ full_name: 'fixture/never-contact', pushed_at: '2026-11-20T10:00:00Z', default_branch: 'main', size: settings.mode === 'revoke-ingest' ? 1 : 0 });
  }
  if (['repos/fixture/never-contact/issues', 'repos/fixture/never-contact/pulls', 'repos/fixture/never-contact/branches'].includes(endpoint)) {
    if (endpoint.endsWith('/branches') && control().mode === 'revoke-ingest') revoke();
    return '[]';
  }
  return deny(`gh sync ${endpoint}`);
};
cp.spawn = (command, args) => {
  if (command !== 'gh' || args[0] !== 'api') return deny('spawn');
  record({ type: 'external-async', command, args });
  const endpoint = args[args.indexOf('-X') + 2];
  if (!['repos/fixture/never-contact', 'repos/fixture/never-contact/branches?per_page=100&page=1', 'graphql'].includes(endpoint)) return deny(`gh async ${endpoint}`);
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
  };
  child.kill = close;
  child.stdin.on('finish', () => setImmediate(() => {
    if (closed) return;
    let body;
    if (control().mode === 'probe-unchanged') {
      if (endpoint === 'graphql') {
        body = JSON.stringify({ data: { repository: { nameWithOwner: 'fixture/never-contact', entries: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
      } else if (endpoint.includes('branches')) {
        body = JSON.stringify([{ name: 'main', commit: { sha: 'a'.repeat(40) } }]);
      } else {
        body = JSON.stringify({ full_name: 'fixture/never-contact', pushed_at: '2026-11-20T10:00:00Z', default_branch: 'main' });
      }
    } else {
      body = endpoint === 'graphql' ? JSON.stringify({ errors: [{ message: 'fixture incomplete probe: local audit only' }] }) : endpoint.includes('branches') ? '[]' : '{}';
    }
    child.stdout.write(body);
    close();
  }));
  return child;
};
cp.exec = cp.execSync = cp.spawnSync = cp.fork = () => deny('unexpected child process');
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once('listening', () => process.send?.({ type: 'listening', port: this.address().port }));
  return listen.apply(this, args);
};
syncBuiltinESMExports();
