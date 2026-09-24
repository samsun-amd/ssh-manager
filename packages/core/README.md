# @ssh-manager/core

A small TypeScript library that factors the SSH **inventory -> connection ->
SFTP -> transfer** pipeline out of the `sshm` bash tool, so multiple Node apps
can share one implementation instead of re-deriving it.

Consumed by:

- `~/github/md-reader` — remote markdown read/write
- `~/github/webscp` — two-pane cross-machine SCP/SFTP web UI

The `sshm` bash script in the repo root is a **standalone** tool. These consumers
import this library directly; they do not execute that script for remote file
operations. Common selector behavior follows sshm, but SMC inventory layout and
group discovery and configuration overrides differ (see "Relationship to sshm" below).

---

## Layers

Everything lives under `~/github/ssh-manager/packages/core/src/`. The four
layers compose top-to-bottom; each one only depends on the layers above it.

```
inventory  group config    ->  Endpoint        (pure data, no network)
   |
connection Endpoint         ->  SshSession      (ssh2 Client, optional 1 jump hop, OS + SFTP probe)
   |        SshPool          ->  pooled, health-checked, idle-evicted sessions
   |
fs         SshSession        ->  RemoteFs        (SFTP ops — or exec fallback — + RemotePath + remote ~ expand)
   |
transfer   SshSession(s)     ->  TransferEngine  (hub<->remote + remote<->remote relay, byte progress, abort)
```

### `inventory/` — selector resolution (no network)
`Inventory.load(path?)` reads `{ group_number, nodes }` from a config file and
`resolve(selector, sub?)` flattens the various node shapes into one
**`Endpoint`**. Pure logic — nothing here opens a socket. Also exports
`resolveInventoryPath()` (precedence: explicit path -> `$SSH_REMOTE_JSON` -> `${SSHM_CONFIG_DIR:-$HOME/sshm_config}/ssh_remote_default.json`)
and `adhocEndpoint()` for targets not in the inventory.

Files must use the group object format; legacy arrays fail with conversion
instructions. `group_number` must be a nonnegative safe integer, and `nodes`
must be an array of objects. Group 0 is reserved for `ssh_remote_default.json`
when using managed filenames. Run `convert_legacy_config.sh` to migrate a file.
The public `new Inventory(nodes)` constructor and `raw()` still use node arrays,
so webscp's inline app configuration remains unchanged. Group discovery and
collision warnings belong to the CLI; `Inventory.load(path)` selects one file.

### `connection/` — live sessions + pool
- `SshSession` wraps an ssh2 `Client`. If the `Endpoint` has a `jump`, it opens
  the jump first, `forwardOut`s to the target, and runs SSH over that channel
  (single hop only). On first use it probes the remote OS via `uname -s`
  (failure/Windows -> `'windows'`). Exposes `sftp()`, `exec()`, `detectOs()`,
  `isAlive()`, `end()`.
- **SFTP capability probe.** Some embedded sshds (e.g. a BusyBox SMC) ship no
  SFTP subsystem, so `sftp()` would fail there. `checkSftp()` probes once
  (racing an `sftp()` open against a short timeout) and caches the result in the
  `sftpAvailable` getter (`true` / `false` / `null` before probed). `SshPool`
  runs it right after the OS probe, so by the time a session is handed out its
  capability is known. `execChannel(command)` returns the **raw, unbuffered**
  ssh2 duplex stream (unlike `exec()`, which buffers stdout) — used by the fs and
  transfer layers for binary-safe `cat` streaming on no-SFTP endpoints.
- `SshPool` keeps sessions keyed by `user@host:port` (jump prefixed). Features:
  handshake `readyTimeout`, idle eviction, liveness check on reuse, a
  `maxPerKey` idle-session retention cap, auto-eviction when the transport dies, and `withSession()`
  (acquire / run / always release).

### `fs/` — SFTP + OS-aware paths (with exec fallback)
- `RemoteFs` promisifies SFTP: `list`, `readFile`, `writeFile`, `mkdirp`,
  `rename`, `remove`, `stat`. Resolves remote `~` via SFTP `realpath('.')` (works
  on both POSIX and Windows OpenSSH; no shell needed) and caches it.
- **Exec fallback (no SFTP).** When `session.sftpAvailable === false`, every
  method transparently switches to POSIX/BusyBox shell commands over `exec` /
  `execChannel` instead of SFTP — same public signatures, so callers don't care:
  `home()` via `printf %s "$HOME"`, `stat`/`list` via `stat -c '%F|%s|%Y|%n'`
  (with `find -maxdepth 1` for listing), `mkdirp` via `mkdir -p`, `remove` via
  `rm -rf`, and `readFile`/`writeFile` via binary-safe `cat` / `cat > file`
  (no `base64`, no truncation). SFTP endpoints are byte-for-byte unchanged.
  Limitation: the line-parsed `list` does not support filenames containing a
  literal newline (fine for the embedded targets this serves).
- `RemotePath` is an OS-aware path helper (posix vs windows). It always sends
  forward slashes over the wire but understands Windows drive letters / UNC for
  display. `normalize()` collapses `.`/`..` and `isUnder(parent, child)` is the
  **security boundary check** consumers use to keep operations inside a root —
  it normalizes traversal before a prefix comparison so `..` cannot escape.

### `transfer/` — streaming transfers
`TransferEngine` streams with byte progress and `AbortSignal` support:
- `hubToRemote` / `remoteToHub` — upload / download (files or, with
  `recursive`, trees).
- `remoteToRemote` — relays A -> B **through the hub** without spilling to disk
  (the hub is the only machine guaranteed to reach both ends).

Every transfer pipes through a single helper that, on an error from **either**
side or on abort, destroys both streams and removes the abort listener exactly
once — so a failed transfer never leaks a channel.

**Per-side stream selection.** Each end of a transfer independently uses SFTP or
the exec fallback based on its `sftpAvailable`, via `openRead` / `openWrite`. So
a relay works for **any** mix — SFTP↔SFTP, SFTP↔exec, exec↔exec — letting an
SFTP host copy to/from a no-SFTP SMC through the hub. `execstream.ts` provides
`execReadStream` (`cat`) and `execWriteStream` (`cat > file`); the writer signals
completion only after the remote process **exits 0**, never on stdin flush alone,
so an upload can't be silently truncated.

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

### Selector -> Endpoint mapping

| call | result |
|---|---|
| `resolve('client')` | client node, direct |
| `resolve('server1')` | server's **BMC**, direct (bare server name = BMC) |
| `resolve('3')` | 3rd inventory node (1-based), default connection |
| `resolve('10.0.0.11')` | IP search across clients and server bmc / smc / hosts |
| `resolve('server1', 'bmc')` | the BMC directly |
| `resolve('server1', 'host2')` | host #2 (1-based), direct |
| `resolve('server1', 'smc')` | embedded `server1.smc` **via this server's BMC jump** |

Host, BMC, and client IP matches connect directly. An embedded SMC IP match uses
the owning server's BMC as the jump when configured. Ports default to `22`.
Core supports `client` and `server` nodes; it does not resolve the CLI's
standalone `type: "smc"` nodes. To select an SMC, its server must declare an `smc` block.

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
# new Node processes load the refreshed dist/; restart running consumers to reload it
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

// 1. inventory: group config -> Endpoint
const inv = Inventory.load();                 // $SSH_REMOTE_JSON or ~/sshm_config/ssh_remote_default.json
const ep  = inv.resolve('server1', 'host2');  // host connects directly
const ad  = adhocEndpoint({ host, port, user, password });

// 2. connection: pooled ssh2 sessions w/ readyTimeout + idle evict + health check
const pool = new SshPool({ readyTimeoutMs: 15000, idleTimeoutMs: 60000, maxPerKey: 4 });
await pool.withSession(ep, async (session) => {
  // session.sftpAvailable is already probed; RemoteFs picks SFTP or the exec
  // fallback automatically — same calls either way.
  // 3. fs: SFTP (or exec) operations, OS-aware paths, remote ~ expansion
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

## Relationship to sshm

The CLI and core have separate runtimes and these current differences:

| Behavior | Bash CLI | TypeScript core |
|---|---|---|
| Inventory path | explicit `-g` -> `SSHM_CONFIG` -> default config | explicit path -> `SSH_REMOTE_JSON` -> default config |
| Default directory | `SSHM_CONFIG_DIR` or `~/sshm_config` | `SSHM_CONFIG_DIR` or `~/sshm_config` |
| File envelope | `{ group_number, nodes }` | `{ group_number, nodes }` |
| SMC configuration | one standalone `type: "smc"` node, shared across server selections | an embedded `smc` block on each server |
| Host connection | direct | direct |
| SMC sub-target connection | via the selected server's BMC | via the owning server's BMC |
| Directory transfer | tar stream with optional gzip, SCP fallback | per-file SFTP or exec streams |

`md-reader` creates ad-hoc endpoints from its own remote-root settings and does
not load this inventory. `webscp` uses core inventory resolution or ad-hoc
endpoints. Its inline config is unaffected, but external legacy inventory files
must be converted before switching core versions. Existing array-only external
file fixtures must likewise be wrapped. Keep these consumer interfaces stable
when changing the CLI.

`~/github/ssh-manager/shared/` contains reference data, with limited test integration:

- `inventory-conformance.json` — `(selector -> expected Endpoint)` cases plus a
  sample inventory. This library's `inventory.test.js` asserts against every
  case, and webscp tests use its inventory. The CLI QA does not consume this
  fixture, whose embedded SMC shape is specific to core.
- `transfer-policy.json` — reference values for the CLI's tar threshold and
  already-compressed extensions. Neither runtime currently reads this file;
  the CLI keeps its defaults in `sshm`, with environment overrides.

When changing common selector behavior, check both implementations and their
tests. SMC schema unification is a separate compatibility change, not implied
by editing these reference files.
