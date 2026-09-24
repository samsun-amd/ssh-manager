'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Inventory, adhocEndpoint, resolveInventoryPath } = require('../dist/index.js');

const FIXTURE_PATH = path.join(__dirname, '..', '..', '..', 'shared', 'inventory-conformance.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

/** Write a group config to a temp file and load its nodes. */
function loadFrom(nodes) {
  const file = path.join(os.tmpdir(), `inv-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ group_number: 0, nodes }), 'utf8');
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

test('IP search for a server host resolves directly (no jump)', () => {
  const ep = inv.resolve('10.0.0.11'); // server1 host1
  assert.strictEqual(ep.id, 'server1/host1');
  assert.strictEqual(ep.conn.host, '10.0.0.11');
  assert.strictEqual(ep.jump, undefined);
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
  // server1 now carries an embedded SMC, shown inline in the summary.
  assert.deepStrictEqual(rows[0], {
    num: 1,
    type: 'Server',
    name: 'server1',
    endpoint: 'BMC: 10.0.0.1, Hosts: 10.0.0.11, SMC: 10.0.0.60 (via BMC)',
  });
  const client = rows.find((r) => r.name === 'client');
  assert.strictEqual(client.type, 'Client');
  assert.strictEqual(client.endpoint, '10.0.0.50');
});

test('embedded SMC resolves via the server BMC jump', () => {
  const ep = inv.resolve('server1', 'smc');
  assert.strictEqual(ep.id, 'server1/smc');
  assert.strictEqual(ep.conn.host, '10.0.0.60');
  assert.ok(ep.jump);
  assert.strictEqual(ep.jump.host, '10.0.0.1');
});

test('IP search for an embedded SMC carries the BMC as jump', () => {
  const ep = inv.resolve('10.0.0.60');
  assert.strictEqual(ep.id, 'server1/smc');
  assert.strictEqual(ep.conn.host, '10.0.0.60');
  assert.ok(ep.jump);
  assert.strictEqual(ep.jump.host, '10.0.0.1');
});

test('smc sub on a server without an embedded SMC throws', () => {
  const ep = () => inv.resolve('server2', 'smc');
  assert.throws(ep, /no embedded SMC/);
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

test('Inventory.load throws on an invalid group object', () => {
  const file = path.join(os.tmpdir(), `bad-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ not: 'array' }));
  try {
    assert.throws(() => Inventory.load(file), /must be \{group_number:/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('group format validates metadata and preserves the node API', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-groups-'));
  const file = path.join(dir, 'ssh_remote_tw.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ group_number: 1, nodes: fixture.inventory }));
    const loaded = Inventory.load(file);
    assert.deepStrictEqual(loaded.raw(), fixture.inventory);
    assert.strictEqual(loaded.resolve('server1', 'smc').jump.host, '10.0.0.1');
    for (const invalid of [fixture.inventory, null, {},
      { group_number: -1, nodes: [] }, { group_number: 1.5, nodes: [] },
      { group_number: '1', nodes: [] }, { group_number: 9007199254740992, nodes: [] },
      { group_number: 1, nodes: [null] }, { group_number: 1, nodes: [[]] }]) {
      fs.writeFileSync(file, JSON.stringify(invalid));
      assert.throws(() => Inventory.load(file), /convert legacy arrays/);
    }
    fs.writeFileSync(file, JSON.stringify({ group_number: 0, nodes: [] }));
    assert.throws(() => Inventory.load(file), /Group 0 is reserved/);
    const defaultFile = path.join(dir, 'ssh_remote_default.json');
    fs.writeFileSync(defaultFile, JSON.stringify({ group_number: 1, nodes: [] }));
    assert.throws(() => Inventory.load(defaultFile), /Group 0 is reserved/);
    fs.writeFileSync(defaultFile, JSON.stringify({ group_number: 0, nodes: [] }));
    assert.deepStrictEqual(Inventory.load(defaultFile).raw(), []);
    // Inline consumer inventories remain arrays passed to the constructor.
    assert.deepStrictEqual(new Inventory(fixture.inventory).raw(), fixture.inventory);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default config path and environment override precedence', () => {
  const previous = { SSH_REMOTE_JSON: process.env.SSH_REMOTE_JSON, SSHM_CONFIG_DIR: process.env.SSHM_CONFIG_DIR };
  try {
    delete process.env.SSH_REMOTE_JSON;
    delete process.env.SSHM_CONFIG_DIR;
    assert.strictEqual(resolveInventoryPath(), path.join(os.homedir(), 'sshm_config', 'ssh_remote_default.json'));
    process.env.SSHM_CONFIG_DIR = path.join(os.tmpdir(), 'custom-configs');
    assert.strictEqual(resolveInventoryPath(), path.join(process.env.SSHM_CONFIG_DIR, 'ssh_remote_default.json'));
    process.env.SSH_REMOTE_JSON = path.join(os.tmpdir(), 'explicit.json');
    assert.strictEqual(resolveInventoryPath(), process.env.SSH_REMOTE_JSON);
    assert.strictEqual(resolveInventoryPath('argument.json'), 'argument.json');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
