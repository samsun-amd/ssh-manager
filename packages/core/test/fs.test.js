'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Readable, Writable } = require('node:stream');

const { RemoteFs } = require('../dist/index.js');

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

/**
 * A minimal in-memory fake SFTPWrapper covering the methods RemoteFs uses:
 * realpath, stat, readdir, createReadStream, createWriteStream, mkdir, rename,
 * unlink, rmdir. Backed by a flat map of path -> {type, data}.
 */
function makeFakeSftp(tree) {
  // tree: { '/home/u': {dir:true}, '/home/u/a.txt': {data:Buffer} ... }
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
      cb(null, '/home/u');
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
        if (rest.includes('/')) continue; // only direct children
        out.push({ filename: rest, attrs: attrsFor(p) });
      }
      cb(null, out);
    },
    createReadStream(p) {
      const n = nodes.get(p);
      const data = n && n.data ? n.data : Buffer.alloc(0);
      return Readable.from([data]);
    },
    createWriteStream(p) {
      const chunks = [];
      const ws = new Writable({
        write(chunk, _enc, done) {
          chunks.push(Buffer.from(chunk));
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
    rename(from, to, cb) {
      const n = nodes.get(from);
      nodes.delete(from);
      nodes.set(to, n);
      cb(null);
    },
    unlink(p, cb) {
      nodes.delete(p);
      cb(null);
    },
    rmdir(p, cb) {
      nodes.delete(p);
      cb(null);
    },
  };
}

function fakeSession(sftp, os = 'posix') {
  return { os, sftp: () => Promise.resolve(sftp) };
}

test('home() uses realpath and caches', async () => {
  let calls = 0;
  const sftp = makeFakeSftp({});
  const orig = sftp.realpath;
  sftp.realpath = (p, cb) => {
    calls += 1;
    orig(p, cb);
  };
  const rfs = new RemoteFs(fakeSession(sftp));
  assert.strictEqual(await rfs.home(), '/home/u');
  await rfs.home();
  assert.strictEqual(calls, 1, 'realpath cached');
});

test('expandHome replaces leading ~', async () => {
  const sftp = makeFakeSftp({});
  const rfs = new RemoteFs(fakeSession(sftp));
  assert.strictEqual(await rfs.expandHome('~'), '/home/u');
  assert.strictEqual(await rfs.expandHome('~/docs/f.txt'), '/home/u/docs/f.txt');
  assert.strictEqual(await rfs.expandHome('/abs/path'), '/abs/path');
});

test('stat returns a DirEntry with type and mtime ms', async () => {
  const sftp = makeFakeSftp({ '/home/u/a.txt': { data: Buffer.from('hi') } });
  const rfs = new RemoteFs(fakeSession(sftp));
  const e = await rfs.stat('/home/u/a.txt');
  assert.strictEqual(e.name, 'a.txt');
  assert.strictEqual(e.type, 'file');
  assert.strictEqual(e.size, 2);
  assert.strictEqual(e.mtime, 1700000000 * 1000);
});

test('list hides dotfiles by default, sorts dirs first', async () => {
  const sftp = makeFakeSftp({
    '/home/u/.hidden': { data: Buffer.from('x') },
    '/home/u/b.txt': { data: Buffer.from('x') },
    '/home/u/adir': { dir: true },
  });
  const rfs = new RemoteFs(fakeSession(sftp));
  const names = (await rfs.list('/home/u')).map((e) => e.name);
  assert.deepStrictEqual(names, ['adir', 'b.txt']); // dir first, no dotfile
});

test('list includeHidden + extension filter', async () => {
  const sftp = makeFakeSftp({
    '/home/u/.dot': { data: Buffer.from('x') },
    '/home/u/a.md': { data: Buffer.from('x') },
    '/home/u/b.txt': { data: Buffer.from('x') },
  });
  const rfs = new RemoteFs(fakeSession(sftp));
  const names = (await rfs.list('/home/u', { includeHidden: true, extensions: ['md'] })).map((e) => e.name);
  // .dot is included by includeHidden but excluded by the .md extension filter
  // (it is a file whose extension is "dot", not "md").
  assert.deepStrictEqual(names.sort(), ['a.md']);
});

test('readFile returns buffer contents', async () => {
  const sftp = makeFakeSftp({ '/home/u/a.txt': { data: Buffer.from('hello') } });
  const rfs = new RemoteFs(fakeSession(sftp));
  const buf = await rfs.readFile('/home/u/a.txt');
  assert.strictEqual(buf.toString(), 'hello');
});

test('writeFile writes through SFTP createWriteStream', async () => {
  const sftp = makeFakeSftp({});
  const rfs = new RemoteFs(fakeSession(sftp));
  await rfs.writeFile('/home/u/new.txt', 'data!');
  assert.strictEqual(sftp._writes.length, 1);
  assert.strictEqual(sftp._writes[0].data.toString(), 'data!');
});

test('mkdirp creates each ancestor segment (posix absolute)', async () => {
  const sftp = makeFakeSftp({});
  const made = [];
  const orig = sftp.mkdir;
  sftp.mkdir = (p, cb) => {
    made.push(p);
    orig(p, cb);
  };
  const rfs = new RemoteFs(fakeSession(sftp));
  await rfs.mkdirp('/home/u/x/y');
  assert.deepStrictEqual(made, ['/home', '/home/u', '/home/u/x', '/home/u/x/y']);
});

test('rename moves a node', async () => {
  const sftp = makeFakeSftp({ '/home/u/a.txt': { data: Buffer.from('x') } });
  const rfs = new RemoteFs(fakeSession(sftp));
  await rfs.rename('/home/u/a.txt', '/home/u/b.txt');
  assert.ok(!sftp._nodes.has('/home/u/a.txt'));
  assert.ok(sftp._nodes.has('/home/u/b.txt'));
});

test('remove unlinks a file', async () => {
  const sftp = makeFakeSftp({ '/home/u/a.txt': { data: Buffer.from('x') } });
  const rfs = new RemoteFs(fakeSession(sftp));
  await rfs.remove('/home/u/a.txt');
  assert.ok(!sftp._nodes.has('/home/u/a.txt'));
});

test('remove recurses into a directory', async () => {
  const sftp = makeFakeSftp({
    '/home/u/d': { dir: true },
    '/home/u/d/f1': { data: Buffer.from('x') },
    '/home/u/d/sub': { dir: true },
    '/home/u/d/sub/f2': { data: Buffer.from('y') },
  });
  const rfs = new RemoteFs(fakeSession(sftp));
  await rfs.remove('/home/u/d');
  assert.ok(!sftp._nodes.has('/home/u/d'));
  assert.ok(!sftp._nodes.has('/home/u/d/f1'));
  assert.ok(!sftp._nodes.has('/home/u/d/sub/f2'));
});
