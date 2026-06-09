'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Inventory, adhocEndpoint, resolveInventoryPath } = require('../dist/index.js');

const FIXTURE_PATH = path.join(__dirname, '..', '..', '..', 'shared', 'inventory-conformance.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

/** Write an inventory array to a temp file and load it. */
function loadFrom(nodes) {
  const file = path.join(os.tmpdir(), `inv-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(nodes), 'utf8');
  try {
    return Inventory.load(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const inv = loadFrom(fixture.inventory);

// ---- 1. Conformance: every case must match sshm's expected behavior. ----
test('conformance fixture has cases', () => {
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0);
});

for (const [i, c] of fixture.cases.entries()) {
  const label = `conformance[${i}] ${c.selector}${c.sub ? '/' + c.sub : ''}`;
  test(label, () => {
    const ep = inv.resolve(c.selector, c.sub);
    assert.strictEqual(ep.id, c.expect.id, 'id');
    // conn: assert host/port/user (password is not in the fixture).
    assert.strictEqual(ep.conn.host, c.expect.conn.host, 'conn.host');
    assert.strictEqual(ep.conn.port, c.expect.conn.port, 'conn.port');
    assert.strictEqual(ep.conn.user, c.expect.conn.user, 'conn.user');
    if (c.expect.jump === null) {
      assert.strictEqual(ep.jump, undefined, 'jump should be absent');
    } else {
      assert.ok(ep.jump, 'jump should be present');
      assert.strictEqual(ep.jump.host, c.expect.jump.host, 'jump.host');
      assert.strictEqual(ep.jump.port, c.expect.jump.port, 'jump.port');
      assert.strictEqual(ep.jump.user, c.expect.jump.user, 'jump.user');
    }
  });
}

// ---- 2. Unit tests for selectors & helpers. ----
test('number selector resolves nth node (1-based)', () => {
  const ep = inv.resolve('1'); // server1 -> bmc default
  assert.strictEqual(ep.id, 'server1/bmc');
  assert.strictEqual(ep.conn.host, '10.0.0.1');
});

test('name selector resolves client direct, includes password', () => {
  const ep = inv.resolve('client');
  assert.strictEqual(ep.id, 'client');
  assert.strictEqual(ep.conn.password, 'secret');
});

test('IP search for a server host carries the BMC as jump', () => {
  const ep = inv.resolve('10.0.0.11'); // server1 host1
  assert.strictEqual(ep.id, 'server1/host1');
  assert.strictEqual(ep.conn.host, '10.0.0.11');
  assert.ok(ep.jump);
  assert.strictEqual(ep.jump.host, '10.0.0.1');
  assert.strictEqual(ep.jump.user, 'root');
});

test('IP search for a BMC ip resolves to <name>/bmc with no jump', () => {
  const ep = inv.resolve('10.0.0.2');
  assert.strictEqual(ep.id, 'server2/bmc');
  assert.strictEqual(ep.conn.port, 2222);
  assert.strictEqual(ep.jump, undefined);
});

test('unknown name selector throws', () => {
  assert.throws(() => inv.resolve('does-not-exist'), /not found in inventory/);
});

test('unknown IP throws', () => {
  assert.throws(() => inv.resolve('1.2.3.4'), /No inventory entry with IP/);
});

test('out-of-range number selector throws', () => {
  assert.throws(() => inv.resolve('999'), /not found in inventory/);
});

test('unknown sub-target throws', () => {
  assert.throws(() => inv.resolve('server1', 'bogus'), /Unknown sub-target/);
});

test('host index out of range throws', () => {
  assert.throws(() => inv.resolve('server1', 'host9'), /not defined/);
});

test('smc sub on a non-server throws (no BMC jump)', () => {
  assert.throws(() => inv.resolve('client', 'smc'), /needs a BMC jump|not a server/);
});

test('list() summary shape', () => {
  const rows = inv.list();
  assert.strictEqual(rows.length, fixture.inventory.length);
  assert.deepStrictEqual(rows[0], {
    num: 1,
    type: 'Server',
    name: 'server1',
    endpoint: 'BMC: 10.0.0.1, Hosts: 10.0.0.11',
  });
  const client = rows.find((r) => r.name === 'client');
  assert.strictEqual(client.type, 'Client');
  assert.strictEqual(client.endpoint, '10.0.0.50');
  const smc = rows.find((r) => r.name === 'smc');
  assert.strictEqual(smc.type, 'SMC');
  assert.match(smc.endpoint, /via BMC/);
});

test('raw() returns the underlying nodes', () => {
  assert.strictEqual(inv.raw().length, fixture.inventory.length);
  assert.strictEqual(inv.raw()[0].name, 'server1');
});

// ---- 3. adhocEndpoint ----
test('adhocEndpoint without jump', () => {
  const ep = adhocEndpoint({ host: '1.2.3.4', user: 'bob', password: 'pw' });
  assert.strictEqual(ep.id, 'adhoc:1.2.3.4');
  assert.strictEqual(ep.conn.port, 22);
  assert.strictEqual(ep.conn.user, 'bob');
  assert.strictEqual(ep.jump, undefined);
});

test('adhocEndpoint with jump and custom port/label', () => {
  const ep = adhocEndpoint({
    host: '1.2.3.4',
    port: 0, // 0 should fall back to 22
    user: 'bob',
    label: 'mybox',
    jump: { host: '5.6.7.8', user: 'gw', port: 2022 },
  });
  assert.strictEqual(ep.id, 'mybox');
  assert.strictEqual(ep.conn.port, 22);
  assert.ok(ep.jump);
  assert.strictEqual(ep.jump.host, '5.6.7.8');
  assert.strictEqual(ep.jump.port, 2022);
});

// ---- 4. resolveInventoryPath precedence ----
test('resolveInventoryPath honors explicit arg', () => {
  assert.strictEqual(resolveInventoryPath('/tmp/x.json'), '/tmp/x.json');
});

test('resolveInventoryPath honors SSH_REMOTE_JSON env', () => {
  const prev = process.env.SSH_REMOTE_JSON;
  process.env.SSH_REMOTE_JSON = '/tmp/env.json';
  try {
    assert.strictEqual(resolveInventoryPath(), '/tmp/env.json');
  } finally {
    if (prev === undefined) delete process.env.SSH_REMOTE_JSON;
    else process.env.SSH_REMOTE_JSON = prev;
  }
});

test('Inventory.load throws on non-array JSON', () => {
  const file = path.join(os.tmpdir(), `bad-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ not: 'array' }));
  try {
    assert.throws(() => Inventory.load(file), /must be a JSON array/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
