'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

// --- Inject a fake ssh2 into the require cache BEFORE loading dist. ---
const ssh2Path = require.resolve('ssh2');

// Each fake Client records connect() opts and emits 'ready' asynchronously.
let liveClients = [];
class FakeSock {
  constructor() {
    this.destroyed = false;
    this.writable = true;
  }
}
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.ended = false;
    this.connectOpts = null;
    this._sock = new FakeSock();
    liveClients.push(this);
  }
  connect(opts) {
    this.connectOpts = opts;
    // emulate async ready
    setImmediate(() => this.emit('ready'));
    return this;
  }
  sftp(cb) {
    setImmediate(() => cb(null, new EventEmitter()));
  }
  exec(command, cb) {
    // emulate POSIX `uname -s` so detectOs() -> 'posix'
    setImmediate(() => {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      cb(null, stream);
      setImmediate(() => {
        stream.emit('data', Buffer.from('Linux\n'));
        stream.emit('close', 0);
      });
    });
    return this;
  }
  forwardOut(_a, _b, _c, _d, cb) {
    setImmediate(() => cb(null, new EventEmitter()));
  }
  end() {
    this.ended = true;
    this._sock.destroyed = true;
  }
}

require.cache[ssh2Path] = {
  id: ssh2Path,
  filename: ssh2Path,
  loaded: true,
  exports: { Client: FakeClient },
};

const { SshPool, SshConnectionError } = require('../dist/index.js');

const EP = { id: 'fake', conn: { host: 'h', port: 22, user: 'u', password: 'p' } };
const EP_JUMP = {
  id: 'fakej',
  conn: { host: 'dest', port: 22, user: 'u' },
  jump: { host: 'gw', port: 22, user: 'g' },
};

function reset() {
  liveClients = [];
}

test('SshConnectionError shape', () => {
  const e = new SshConnectionError('ep1', 'boom', new Error('cause'));
  assert.strictEqual(e.name, 'SshConnectionError');
  assert.strictEqual(e.endpointId, 'ep1');
  assert.strictEqual(e.message, 'boom');
  assert.ok(e.cause instanceof Error);
  assert.ok(e instanceof Error);
});

test('acquire connects, detects OS, sets poolKey', async () => {
  reset();
  const pool = new SshPool();
  const s = await pool.acquire(EP);
  assert.strictEqual(s.os, 'posix');
  assert.strictEqual(s.poolKey, 'u@h:22');
  assert.strictEqual(liveClients.length, 1);
  pool.closeAll();
});

test('release then acquire reuses the same live session (no new client)', async () => {
  reset();
  const pool = new SshPool();
  const s1 = await pool.acquire(EP);
  pool.release(s1);
  const s2 = await pool.acquire(EP);
  assert.strictEqual(s2, s1, 'should reuse pooled session');
  assert.strictEqual(liveClients.length, 1, 'no second client created');
  pool.closeAll();
});

test('dead session is not reused; a fresh one is created', async () => {
  reset();
  const pool = new SshPool();
  const s1 = await pool.acquire(EP);
  pool.release(s1);
  // Kill the transport underneath.
  liveClients[0]._sock.destroyed = true;
  assert.strictEqual(s1.isAlive(), false);
  const s2 = await pool.acquire(EP);
  assert.notStrictEqual(s2, s1, 'must not reuse a dead session');
  assert.strictEqual(liveClients.length, 2);
  pool.closeAll();
});

test('different endpoints get different pool keys / clients', async () => {
  reset();
  const pool = new SshPool();
  const a = await pool.acquire(EP);
  const b = await pool.acquire({ id: 'other', conn: { host: 'h2', port: 22, user: 'u' } });
  assert.notStrictEqual(a.poolKey, b.poolKey);
  assert.strictEqual(liveClients.length, 2);
  pool.closeAll();
});

test('jump key includes the jump hop', async () => {
  reset();
  const pool = new SshPool();
  const s = await pool.acquire(EP_JUMP);
  assert.strictEqual(s.poolKey, 'g@gw:22>u@dest:22');
  // jump path creates jumpClient + target client = 2
  assert.strictEqual(liveClients.length, 2);
  pool.closeAll();
});

test('release over maxPerKey evicts (ends) the extra session', async () => {
  reset();
  const pool = new SshPool({ maxPerKey: 1 });
  const s1 = await pool.acquire(EP);
  const s2 = await pool.acquire(EP); // same key, 2 checked out
  pool.release(s1); // 1 idle, at cap
  pool.release(s2); // would exceed cap -> evicted/ended
  assert.strictEqual(s2.isAlive(), false, 's2 should be ended by eviction');
  pool.closeAll();
});

test('acquire on a closed pool throws', async () => {
  reset();
  const pool = new SshPool();
  pool.closeAll();
  await assert.rejects(() => pool.acquire(EP), /pool is closed/);
});

test('withSession releases automatically', async () => {
  reset();
  const pool = new SshPool();
  let inner;
  const r = await pool.withSession(EP, async (s) => {
    inner = s;
    return 42;
  });
  assert.strictEqual(r, 42);
  // after release it should be reusable
  const s2 = await pool.acquire(EP);
  assert.strictEqual(s2, inner);
  pool.closeAll();
});

test('closeAll ends all clients', async () => {
  reset();
  const pool = new SshPool();
  await pool.acquire(EP);
  await pool.acquire({ id: 'x', conn: { host: 'h9', port: 22, user: 'u' } });
  pool.closeAll();
  assert.ok(liveClients.every((c) => c.ended), 'all clients ended');
});
