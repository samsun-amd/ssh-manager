'use strict';

// Regression tests for connection/pool resource-leak fixes:
//  - SshSession.sftp() drops a cached wrapper when the channel closes/errors.
//  - SshPool.acquire() does not leak a session created during a racing closeAll.

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const ssh2Path = require.resolve('ssh2');

let liveClients = [];
let liveSftps = [];
class FakeSock {
  constructor() { this.destroyed = false; this.writable = true; }
}
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.ended = false;
    this._sock = new FakeSock();
    liveClients.push(this);
  }
  connect() { setImmediate(() => this.emit('ready')); return this; }
  sftp(cb) {
    setImmediate(() => {
      const s = new EventEmitter();
      liveSftps.push(s);
      cb(null, s);
    });
  }
  exec(command, cb) {
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
  forwardOut(_a, _b, _c, _d, cb) { setImmediate(() => cb(null, new EventEmitter())); }
  end() { this.ended = true; this._sock.destroyed = true; }
}

require.cache[ssh2Path] = {
  id: ssh2Path, filename: ssh2Path, loaded: true, exports: { Client: FakeClient },
};

const { SshPool } = require('../dist/index.js');
const EP = { id: 'fake', conn: { host: 'h', port: 22, user: 'u', password: 'p' } };

function reset() { liveClients = []; liveSftps = []; }

test('sftp() re-opens after the cached channel closes', async () => {
  reset();
  const pool = new SshPool();
  const s = await pool.acquire(EP);
  const w1 = await s.sftp();
  const w2 = await s.sftp();
  assert.strictEqual(w1, w2, 'same channel cached while alive');
  // Channel dies.
  w1.emit('close');
  const w3 = await s.sftp();
  assert.notStrictEqual(w3, w1, 'a fresh channel must be opened after close');
  assert.strictEqual(liveSftps.length, 2, 'exactly two channels created');
  pool.closeAll();
});

test('acquire during a racing closeAll does not leak the session', async () => {
  reset();
  const pool = new SshPool();
  const p = pool.acquire(EP);
  // Close the pool while acquire is still awaiting connect/detectOs.
  pool.closeAll();
  await assert.rejects(p, /pool is closed/);
  // The client that was created must have been ended (not orphaned).
  assert.ok(liveClients.length >= 1);
  assert.ok(liveClients.every((c) => c.ended), 'every created client ended');
});
