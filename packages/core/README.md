# @ssh-manager/core

A small TypeScript library that factors the SSH **inventory -> connection ->
SFTP -> transfer** pipeline out of the `sshm` bash tool, so multiple Node apps
can share one implementation instead of re-deriving it.

Consumed by:

- `~/github/md-reader` — remote markdown read/write
- `~/github/webscp` — two-pane cross-machine SCP/SFTP web UI

The `sshm` bash script in the repo root is a **standalone** tool and is never
changed by this package. This library is a faithful **mirror** of sshm's
inventory/selector semantics in TypeScript, kept aligned via a shared fixture
(see "Relationship to sshm" below).

---

## Layers

Everything lives under `~/github/ssh-manager/packages/core/src/`. The four
layers compose top-to-bottom; each one only depends on the layers above it.

```
inventory  ssh_remote.json  ->  Endpoint        (pure data, no network)
   |
connection Endpoint         ->  SshSession      (ssh2 Client, optional 1 jump hop, OS probe)
   |        SshPool          ->  pooled, health-checked, idle-evicted sessions
   |
fs         SshSession        ->  RemoteFs        (SFTP ops + RemotePath + remote ~ expand)
   |
transfer   SshSession(s)     ->  TransferEngine  (hub<->remote + remote<->remote relay, byte progress, abort)
```

### `inventory/` — selector resolution (no network)
`Inventory.load(path?)` reads `ssh_remote.json` (a JSON **array** of nodes) and
`resolve(selector, sub?)` flattens the various node shapes into one
**`Endpoint`**. Pure logic — nothing here opens a socket. Also exports
`resolveInventoryPath()` (precedence: `$SSH_REMOTE_JSON` -> `~/note/ssh_remote.json`)
and `adhocEndpoint()` for targets not in the inventory.

### `connection/` — live sessions + pool
- `SshSession` wraps an ssh2 `Client`. If the `Endpoint` has a `jump`, it opens
  the jump first, `forwardOut`s to the target, and runs SSH over that channel
  (single hop only). On first use it probes the remote OS via `uname -s`
  (failure/Windows -> `'windows'`). Exposes `sftp()`, `exec()`, `detectOs()`,
  `isAlive()`, `end()`.
- `SshPool` keeps sessions keyed by `user@host:port` (jump prefixed). Features:
  handshake `readyTimeout`, idle eviction, liveness check on reuse, a
  `maxPerKey` cap, auto-eviction when the transport dies, and `withSession()`
  (acquire / run / always release).

### `fs/` — SFTP + OS-aware paths
- `RemoteFs` promisifies SFTP: `list`, `readFile`, `writeFile`, `mkdirp`,
  `rename`, `remove`, `stat`. Resolves remote `~` via SFTP `realpath('.')` (works
  on both POSIX and Windows OpenSSH; no shell needed) and caches it.
- `RemotePath` is an OS-aware path helper (posix vs windows). It always sends
  forward slashes over the wire but understands Windows drive letters / UNC for
  display. `normalize()` collapses `.`/`..` and `isUnder(parent, child)` is the
  **security boundary check** consumers use to keep operations inside a root —
  it normalizes traversal before a prefix comparison so `..` cannot escape.

### `transfer/` — streaming transfers
`TransferEngine` streams over SFTP with byte progress and `AbortSignal` support:
- `hubToRemote` / `remoteToHub` — upload / download (files or, with
  `recursive`, trees).
- `remoteToRemote` — relays A -> B **through the hub** over SFTP without
  spilling to disk (the hub is the only machine guaranteed to reach both ends).

Every transfer pipes through a single helper that, on an error from **either**
side or on abort, destroys both streams and removes the abort listener exactly
once — so a failed transfer never leaks an SFTP channel.

### `types.ts`
Shared types plus `SshConnectionError` (carries `endpointId` + `cause`, so a web
consumer can map failures to an HTTP status).

---

## The Endpoint model

`Endpoint` is the central abstraction every layer below `inventory` consumes:

```ts
interface Endpoint {
  id: string;              // stable label, e.g. "client" | "server1/host2"
  conn: SshCredentials;    // final destination { host, port, user, password? }
  jump?: SshCredentials;   // optional single jump hop (the BMC), if any
  os?: RemoteOs;           // 'posix' | 'windows' if declared; else probed
}
```

### Selector -> Endpoint mapping (mirrors sshm)

| call | result |
|---|---|
| `resolve('client')` | client node, direct |
| `resolve('server1')` | server's **BMC**, direct (bare server name = BMC) |
| `resolve('3')` | 3rd inventory node (1-based), default connection |
| `resolve('10.0.0.11')` | IP search across client / smc / bmc / hosts |
| `resolve('server1', 'bmc')` | the BMC directly |
| `resolve('server1', 'host2')` | host #2 (1-based) **via the BMC jump** |
| `resolve('server1', 'smc')` | the singleton SMC node **via this server's BMC jump** |

An IP that matches a host-behind-a-BMC resolves with `jump` set to that server's
BMC; an IP that matches a BMC/client/smc resolves direct (no jump). Missing
fields throw a descriptive `Error`; ports default to `22`.

---

## Build & test

```bash
cd ~/github/ssh-manager/packages/core
npm install
npm run build      # tsc -> dist/ (CJS + .d.ts). Must be 0 errors (strict mode).
npm test           # node --test against the compiled dist/
```

`dist/` is git-ignored — always `npm run build` before testing or publishing to a
consumer. The tests run against `dist/`, so a stale build means stale tests.

Tests live in `test/*.test.js` and use Node's built-in `node:test`. ssh2 is
faked via the require cache (no real network), so the suite is hermetic.

---

## How consumers link this package (symlink, NOT `file:`)

Each consumer has a **symlink**:

```
~/github/md-reader/node_modules/@ssh-manager/core  ->  ~/github/ssh-manager/packages/core
~/github/webscp/node_modules/@ssh-manager/core     ->  ~/github/ssh-manager/packages/core
```

It is intentionally a symlink and **not** a `"@ssh-manager/core": "file:..."`
entry in the consumer's `package.json`. Reason: npm rewrites a `file:` spec into
a relative path on install and will not preserve a `~`-relative path — so a
`file:` dep would either bake in a brittle relative path or get clobbered on the
next `npm install`. The symlink keeps the dependency portable and stable
regardless of where the repos sit, as long as the consumer can reach this
package by path.

Workflow after changing core:

```bash
cd ~/github/ssh-manager/packages/core && npm run build   # refresh dist/
# consumers import @ssh-manager/core and pick up the new dist/ immediately
```

If a consumer's symlink is missing, recreate it (adjust for relative vs absolute
as the repo uses):

```bash
mkdir -p ~/github/<consumer>/node_modules/@ssh-manager
ln -s ~/github/ssh-manager/packages/core \
      ~/github/<consumer>/node_modules/@ssh-manager/core
```

---

## API sketch

```ts
import { Inventory, SshPool, RemoteFs, TransferEngine, adhocEndpoint } from '@ssh-manager/core';

// 1. inventory: ssh_remote.json -> Endpoint (mirrors sshm selectors)
const inv = Inventory.load();                 // $SSH_REMOTE_JSON or ~/note/ssh_remote.json
const ep  = inv.resolve('server1', 'host2');  // host via BMC jump
const ad  = adhocEndpoint({ host, port, user, password });

// 2. connection: pooled ssh2 sessions w/ readyTimeout + idle evict + health check
const pool = new SshPool({ readyTimeoutMs: 15000, idleTimeoutMs: 60000, maxPerKey: 4 });
await pool.withSession(ep, async (session) => {
  // 3. fs: SFTP operations, OS-aware paths, remote ~ expansion
  const rfs = new RemoteFs(session);
  const home = await rfs.expandHome('~');
  const entries = await rfs.list(home);
});
pool.closeAll(); // on shutdown

// 4. transfer: SFTP baseline, remote->remote relays through the hub
const engine = new TransferEngine();
await engine.hubToRemote('/local/file', session, '~/file', {
  onProgress: ({ bytes, total }) => {},
  signal: abortController.signal,
});
```

---

## Relationship to sshm (mirror, kept aligned)

`~/github/ssh-manager/shared/` holds language-neutral fixtures so the bash tool
and this library never drift:

- `inventory-conformance.json` — `(selector -> expected Endpoint)` cases plus a
  sample inventory. This library's `inventory.test.js` asserts against every
  case; a matching `sshm` harness can assert the same fixture. Add a case here
  whenever you add or change selector behavior in **either** implementation.
- `transfer-policy.json` — the de-hardcoded transfer tuning (tar threshold,
  already-compressed extension list) that `sshm` previously embedded; sshm reads
  it with `jq`, core can import it.

Rule of thumb: **never change selector semantics in only one place.** Update the
fixture and both implementations together.
