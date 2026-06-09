'use strict';

// Regression tests for stream teardown in TransferEngine: an error on one side
// must destroy the other side (no leaked SFTP channel), and the AbortSignal
// listener must be removed so the signal is not retained after completion.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');

const { TransferEngine } = require('../dist/index.js');

function fakeSession(sftp, osName = 'posix') {
  return { os: osName, sftp: () => Promise.resolve(sftp) };
}

let tmpRoot;
test('setup', () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xfer-leak-'));
});

test('write-side error destroys the read stream (no leak)', async () => {
  const local = path.join(tmpRoot, 'src.txt');
  fs.writeFileSync(local, 'x'.repeat(64 * 1024));

  let readDestroyed = false;
  const sftp = {
    realpath(p, cb) { cb(null, '/home/u'); },
    createWriteStream() {
      // A writable that errors as soon as it receives data.
      const ws = new Writable({
        write(_c, _e, done) {
          done(new Error('disk full'));
        },
      });
      return ws;
    },
  };

  // Wrap createReadStream on the local fs path is not possible; instead observe
  // that the returned promise rejects (which only happens if the error path is
  // wired) and that the read stream was torn down via the engine's own logic.
  const eng = new TransferEngine();
  const realCreate = fs.createReadStream;
  fs.createReadStream = (p, o) => {
    const rs = realCreate.call(fs, p, o);
    const origDestroy = rs.destroy.bind(rs);
    rs.destroy = (...a) => { readDestroyed = true; return origDestroy(...a); };
    return rs;
  };
  try {
    await assert.rejects(
      () => eng.hubToRemote(local, fakeSession(sftp), '/home/u/dst.txt'),
      /disk full/,
    );
  } finally {
    fs.createReadStream = realCreate;
  }
  assert.strictEqual(readDestroyed, true, 'read stream must be destroyed on write error');
});

test('read-side error destroys the write stream (no leak)', async () => {
  // For remoteToHub the read side is the SFTP stream and the write side is the
  // LOCAL fs write stream, so spy on fs.createWriteStream.
  let writeDestroyed = false;
  const sftp = {
    realpath(p, cb) { cb(null, '/home/u'); },
    stat(p, cb) { cb(null, { mode: 0o100644, size: 10, mtime: 1 }); },
    createReadStream() {
      const rs = new Readable({ read() {} });
      setImmediate(() => rs.emit('error', new Error('read fault')));
      return rs;
    },
  };
  const out = path.join(tmpRoot, 'out.txt');
  const eng = new TransferEngine();
  const realCreate = fs.createWriteStream;
  fs.createWriteStream = (p, o) => {
    const ws = realCreate.call(fs, p, o);
    const origDestroy = ws.destroy.bind(ws);
    ws.destroy = (...a) => { writeDestroyed = true; return origDestroy(...a); };
    return ws;
  };
  try {
    await assert.rejects(
      () => eng.remoteToHub(fakeSession(sftp), '/home/u/r.txt', out),
      /read fault/,
    );
  } finally {
    fs.createWriteStream = realCreate;
  }
  assert.strictEqual(writeDestroyed, true, 'write stream must be destroyed on read error');
});

test('abort listener is removed after a successful transfer', async () => {
  const local = path.join(tmpRoot, 'ok.txt');
  fs.writeFileSync(local, 'payload');
  const nodes = new Map();
  const sftp = {
    realpath(p, cb) { cb(null, '/home/u'); },
    createWriteStream(p) {
      const chunks = [];
      const ws = new Writable({ write(c, _e, d) { chunks.push(Buffer.from(c)); d(); } });
      ws.on('finish', () => { nodes.set(p, Buffer.concat(chunks)); ws.emit('close'); });
      return ws;
    },
  };
  const ac = new AbortController();
  let removed = false;
  const origRemove = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.removeEventListener = (...a) => { removed = true; return origRemove(...a); };
  const eng = new TransferEngine();
  await eng.hubToRemote(local, fakeSession(sftp), '/home/u/ok.txt', { signal: ac.signal });
  assert.strictEqual(removed, true, 'abort listener must be removed after completion');
});

test('cleanup', () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
