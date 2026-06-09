'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { RemotePath } = require('../dist/index.js');

const posix = new RemotePath('posix');
const win = new RemotePath('windows');

// ---- sep ----
test('sep by os', () => {
  assert.strictEqual(posix.sep, '/');
  assert.strictEqual(win.sep, '\\');
});

// ---- isAbsolute ----
test('posix isAbsolute', () => {
  assert.strictEqual(posix.isAbsolute('/x'), true);
  assert.strictEqual(posix.isAbsolute('x'), false);
  assert.strictEqual(posix.isAbsolute('C:\\x'), false);
});

test('windows isAbsolute', () => {
  assert.strictEqual(win.isAbsolute('C:\\x'), true);
  assert.strictEqual(win.isAbsolute('c:/x'), true);
  assert.strictEqual(win.isAbsolute('\\\\server\\share'), true); // UNC
  assert.strictEqual(win.isAbsolute('x'), false);
  assert.strictEqual(win.isAbsolute('C:'), false); // no separator after drive
});

// ---- split ----
test('split posix', () => {
  assert.deepStrictEqual(posix.split('/a/b/c'), ['a', 'b', 'c']);
  assert.deepStrictEqual(posix.split('a//b/'), ['a', 'b']);
});

test('split windows (backslashes normalized)', () => {
  assert.deepStrictEqual(win.split('C:\\a\\b'), ['C:', 'a', 'b']);
});

// ---- basename / dirname ----
test('basename', () => {
  assert.strictEqual(posix.basename('/a/b/c.txt'), 'c.txt');
  assert.strictEqual(posix.basename('/'), '');
  assert.strictEqual(win.basename('C:\\a\\b.txt'), 'b.txt');
});

test('dirname posix', () => {
  assert.strictEqual(posix.dirname('/a/b/c.txt'), '/a/b');
  assert.strictEqual(posix.dirname('/a'), '/');
  assert.strictEqual(posix.dirname('a'), '/'); // idx<=0 -> root
});

test('dirname windows keeps drive root', () => {
  assert.strictEqual(win.dirname('C:\\a\\b.txt'), 'C:/a');
  assert.strictEqual(win.dirname('C:\\a'), 'C:/');
});

// ---- join ----
test('join posix preserves leading slash', () => {
  assert.strictEqual(posix.join('/a', 'b', 'c'), '/a/b/c');
  assert.strictEqual(posix.join('/a/', '/b/', 'c'), '/a/b/c');
  assert.strictEqual(posix.join('a', 'b'), 'a/b');
});

test('join windows uses forward slashes (wire format)', () => {
  assert.strictEqual(win.join('C:\\a', 'b'), 'C:/a/b');
});

// ---- normalize: collapsing . and .. ----
test('normalize collapses . and ..', () => {
  assert.strictEqual(posix.normalize('/a/./b/../c'), '/a/c');
  assert.strictEqual(posix.normalize('/a/b/../../c'), '/c');
});

test('normalize: .. cannot escape an absolute root (security)', () => {
  assert.strictEqual(posix.normalize('/root/../..'), '/');
  assert.strictEqual(posix.normalize('/../../etc/passwd'), '/etc/passwd');
  assert.strictEqual(posix.normalize('/'), '/');
});

test('normalize: relative .. is preserved (cannot anchor)', () => {
  assert.strictEqual(posix.normalize('../a'), '../a');
  assert.strictEqual(posix.normalize('a/../../b'), '../b');
});

test('normalize windows keeps drive and collapses', () => {
  assert.strictEqual(win.normalize('C:\\a\\..\\b'), 'C:/b');
  assert.strictEqual(win.normalize('C:\\a\\..\\..'), 'C:/');
});

// ---- isUnder: the security boundary check ----
test('isUnder true for child and self', () => {
  assert.strictEqual(posix.isUnder('/home/u', '/home/u/sub/f'), true);
  assert.strictEqual(posix.isUnder('/home/u', '/home/u'), true);
});

test('isUnder false for sibling and escape', () => {
  assert.strictEqual(posix.isUnder('/home/u', '/home/user2'), false); // prefix but not boundary
  assert.strictEqual(posix.isUnder('/home/u', '/home'), false);
  assert.strictEqual(posix.isUnder('/home/u', '/home/u/../../etc'), false);
});

test('isUnder normalizes traversal before comparing', () => {
  assert.strictEqual(posix.isUnder('/home/u', '/home/u/x/../y'), true);
  assert.strictEqual(posix.isUnder('/home/u', '/home/u/../u/ok'), true);
});

test('isUnder windows is case-insensitive', () => {
  assert.strictEqual(win.isUnder('C:\\Users\\Bob', 'c:\\users\\bob\\file'), true);
  assert.strictEqual(win.isUnder('C:\\Users\\Bob', 'C:\\Users\\Alice'), false);
});
