'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');

const { TransferEngine } = require('../dist/index.js');

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

// Reuse a minimal fake SFTP (mirrors fs.test.js) with realpath -> remote home.
function makeFakeSftp(tree, home) {
  const nodes = new Map(Object.entries(tree));
  const writes = [];
  function attrsFor(p) {
    const n = nodes.get(p);
    if (!n) return null;
    const mode = n.dir ? S_IFDIR | 0o755 : S_IFREG | 0o644;
    return { mode, size: n.dir ? 0 : n.data.length, mtime: 1700000000 };
  }
  return {
    _nodes: nodes,
    _writes: writes,
    realpath(p, cb) {
      cb(null, home);
    },
    stat(p, cb) {
      const a = attrsFor(p);
      if (!a) return cb(new Error(`No such file: ${p}`));
      cb(null, a);
    },
    readdir(dir, cb) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const out = [];
      for (const [p, n] of nodes) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (rest.includes('/')) continue;
        out.push({ filename: rest, attrs: attrsFor(p) });
      }
      cb(null, out);
    },
    createReadStream(p) {
      const n = nodes.get(p);
      return Readable.from([n && n.data ? n.data : Buffer.alloc(0)]);
    },
    createWriteStream(p) {
      const chunks = [];
      const ws = new Writable({
        write(c, _e, done) {
          chunks.push(Buffer.from(c));
          done();
        },
      });
      ws.on('finish', () => {
        const buf = Buffer.concat(chunks);
        nodes.set(p, { data: buf });
        writes.push({ path: p, data: buf });
        ws.emit('close');
      });
      return ws;
    },
    mkdir(p, cb) {
      nodes.set(p, { dir: true });
      cb && cb(null);
    },
    rename(f, t, cb) { cb(null); },
    unlink(p, cb) { nodes.delete(p); cb(null); },
    rmdir(p, cb) { nodes.delete(p); cb(null); },
  };
}

function fakeSession(sftp, os = 'posix') {
  return { os, sftp: () => Promise.resolve(sftp) };
}

let tmpRoot;
test('setup tmp dir', () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xfer-'));
});

test('hubToRemote streams a single file with progress', async () => {
  const local = path.join(tmpRoot, 'up.txt');
  fs.writeFileSync(local, 'payload-123');
  const sftp = makeFakeSftp({}, '/home/u');
  const eng = new TransferEngine();
  const progress = [];
  await eng.hubToRemote(local, fakeSession(sftp), '/home/u/up.txt', {
    onProgress: (p) => progress.push(p),
  });
  assert.strictEqual(sftp._nodes.get('/home/u/up.txt').data.toString(), 'payload-123');
  assert.ok(progress.length >= 1);
  const last = progress[progress.length - 1];
  assert.strictEqual(last.bytes, 'payload-123'.length);
  assert.strictEqual(last.total, 'payload-123'.length);
});

test('hubToRemote rejects a directory without recursive', async () => {
  const dir = path.join(tmpRoot, 'd1');
  fs.mkdirSync(dir);
  const eng = new TransferEngine();
  await assert.rejects(
    () => eng.hubToRemote(dir, fakeSession(makeFakeSftp({}, '/home/u')), '/home/u/d1'),
    /directory.*recursive/,
  );
});

test('hubToRemote recursive uploads a tree', async () => {
  const dir = path.join(tmpRoot, 'tree');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'BB');
  const sftp = makeFakeSftp({}, '/home/u');
  const eng = new TransferEngine();
  await eng.hubToRemote(dir, fakeSession(sftp), '/home/u/tree', { recursive: true });
  assert.strictEqual(sftp._nodes.get('/home/u/tree/a.txt').data.toString(), 'A');
  assert.strictEqual(sftp._nodes.get('/home/u/tree/sub/b.txt').data.toString(), 'BB');
});

test('remoteToHub downloads a single file', async () => {
  const sftp = makeFakeSftp({ '/home/u/dl.txt': { data: Buffer.from('down!') } }, '/home/u');
  const eng = new TransferEngine();
  const out = path.join(tmpRoot, 'dl.txt');
  await eng.remoteToHub(fakeSession(sftp), '/home/u/dl.txt', out);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'down!');
});

test('remoteToHub expands ~ and downloads', async () => {
  const sftp = makeFakeSftp({ '/home/u/tilde.txt': { data: Buffer.from('T') } }, '/home/u');
  const eng = new TransferEngine();
  const out = path.join(tmpRoot, 'tilde.txt');
  await eng.remoteToHub(fakeSession(sftp), '~/tilde.txt', out);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'T');
});

test('remoteToRemote relays a file through the hub', async () => {
  const src = makeFakeSftp({ '/home/u/r.bin': { data: Buffer.from('relayed') } }, '/home/u');
  const dst = makeFakeSftp({}, '/home/u');
  const eng = new TransferEngine();
  await eng.remoteToRemote(
    fakeSession(src),
    '/home/u/r.bin',
    fakeSession(dst),
    '/home/u/r-copy.bin',
  );
  assert.strictEqual(dst._nodes.get('/home/u/r-copy.bin').data.toString(), 'relayed');
});

test('transfer aborts via AbortSignal', async () => {
  const local = path.join(tmpRoot, 'abort.txt');
  fs.writeFileSync(local, 'x'.repeat(1000));
  const sftp = makeFakeSftp({}, '/home/u');
  const eng = new TransferEngine();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => eng.hubToRemote(local, fakeSession(sftp), '/home/u/abort.txt', { signal: ac.signal }),
    /cancelled/,
  );
});

test('cleanup tmp dir', () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
