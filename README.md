# SSH Manager (sshm)

`sshm` is a lightweight Bash utility for managing SSH, jump-host SSH, and SCP workflows from a JSON inventory.

## Requirements

Install the required tools:

```bash
sudo apt update
sudo apt install jq openssh-client sshpass tar gzip fping pv -y
```

Or run the bundled installer, which handles dependencies, installs the binary, and seeds a private inventory:

```bash
./install.sh
```

`fping` is optional. If it is unavailable, `sshm -p` falls back to `ping`. `sshpass` is only used for inventory entries that store `pass`. `tar`/`gzip` enable fast directory transfers. `pv` is optional and enables a progress bar for directory transfers.

## Configuration

Private configs live in `${SSHM_CONFIG_DIR:-$HOME/sshm_config}`:

```text
ssh_remote_default.json  # group 0
ssh_remote_tw.json       # e.g. group 1
ssh_remote_us.json       # e.g. group 2
```

Group names come from filenames. Names contain letters, digits, `_`, or `-`,
start with a letter or digit, and cannot be numeric-only. `default` is reserved.
Every file uses `{ "group_number": 0, "nodes": [...] }`. Numbers are integers
from 0 to 9007199254740991; only default uses 0. Other groups use positive,
stable numbers; gaps are allowed. Node numbering starts at 1 in each group.

For connection and single-config list commands, the CLI selects a config in this order:

1. Explicit `-g <name|number>`, resolved in the config directory.
2. `SSHM_CONFIG`, an explicit file path.
3. `ssh_remote_default.json` in the config directory.

There is no fallback to legacy files or repository templates. The directory
[`sshm_config/`](sshm_config/) contains default/tw/us templates with example
addresses, not private inventory. Do not commit real credentials or addresses.

```bash
sshm -g                         # list group numbers, names, files, and status
sshm -l                         # list default nodes (or SSHM_CONFIG override)
sshm -g tw -l                   # list tw nodes
sshm -g 1 -c "uptime" server1
sshm -c "uptime" server1 -g tw   # flags may follow the target
sshm -g default 2               # default node 2; -g 0 is equivalent
sshm -g tw -s file remote:/tmp/ server1 smc
sshm -al                        # list nodes in every group, with group headers
sshm -qa                        # live SSH/command checks across all groups
sshm -qa -g tw                  # live checks for tw only (-g 1 also works)
```

Bare `-g` and `-al` are standalone listing commands. Combining either with a
connection/transfer action is an error; `-al -g tw` is also an error. A group
selection without a target/action (such as `sshm -g tw`) reports a missing target.

Duplicate numbers produce warnings on stderr. Only an ambiguous numeric
selection fails: if tw and us both use 1, `-g 1` fails before connecting, while
`-g tw`, `-g us`, default, and unique numbers still work. Malformed configs are
marked invalid and do not block other valid groups. `-al` skips invalid configs;
listing still succeeds when some entries are invalid. Empty config directories
produce a listing error. Configs are independent; nodes and SMC credentials are
not inherited from default.

The separate [`@ssh-manager/core` library](packages/core/README.md) resolves an
explicit path, then `SSH_REMOTE_JSON`, then the same default config directory.
It loads the same object envelope but does not discover or select groups for a UI.
`SSHM_CONFIG` is CLI-only; `SSH_REMOTE_JSON` is core-only.

### Convert a legacy inventory

Runtime loaders accept only the new object format. Run the converter from this
repository before switching an old inventory to the new CLI/core:

```bash
./convert_legacy_config.sh ~/note/ssh_remote.json 0
./convert_legacy_config.sh ./legacy_tw.json 1 tw
```

Output goes to `SSHM_CONFIG_DIR` or `~/sshm_config`. Group 0 takes exactly two
arguments and writes `ssh_remote_default.json`; a positive number requires a
third argument, the group name. Conversion preserves all node values and their
order, including the existing SMC layout. The source is kept. Existing files
or symlinks are never overwritten. Output is published atomically with mode
`600`; duplicate group numbers warn but do not prevent conversion.

Keep legacy files until their callers are migrated. A symlink from the old path
to a new-format file does not make old array-only readers compatible. Update any
explicit `SSHM_CONFIG`, `SSH_REMOTE_JSON`, or webscp `inventoryPath` settings to
the converted file when switching those callers.

## JSON Inventory Schema

The `nodes` array supports these node types:

- `server`: a platform with one BMC and optional host NICs.
- `client`: a standalone SSH target.
- `smc`: an SMC target that can be accessed through a server BMC jump host.

The CLI uses one standalone SMC node in `nodes` for `server1 smc`, `server2 smc`, etc.,
with each server's BMC as the jump host. This supports a fixed SMC IP shared
across separate BMC networks. Core uses an embedded `server.smc` block instead;
the two SMC inventory formats are currently different.

```json
{
  "group_number": 0,
  "nodes": [
    {
      "type": "server",
      "name": "server1",
      "bmc": {
        "ip": "x.x.x.x",
        "port": 22,
        "user": "root",
        "pass": "password"
      },
      "hosts": [
        {
          "ip": "x.x.x.x",
          "port": 22,
          "user": "root",
          "pass": "password"
        }
      ],
      "note": "Example server"
    },
    {
      "type": "client",
      "name": "client1",
      "ip": "x.x.x.x",
      "port": 2222,
      "user": "username",
      "pass": "password",
      "note": "Example client"
    },
    {
      "type": "smc",
      "name": "smc",
      "ip": "x.x.x.x",
      "port": 22,
      "user": "root",
      "pass": "password",
      "note": "SMC accessed through a server BMC"
    }
  ]
}
```

## Usage

```text
SSH Manager - Remote Access Tool
--------------------------------
Usage:
  sshm [-p] [-c "command"] <IP>                 : SSH to IP
  sshm [-p] [-c "command"] <Name|Num>           : SSH to ServerBMC|Client
  sshm [-p] [-c "command"] <Name|Num> host<N>   : SSH to ServerHost (NIC)
  sshm [-p] [-c "command"] <Name|Num> smc       : SSH to SMC via BMC
  sshm [-P <port>] <Name|Num>                   : SSH using a temporary port override
  sshm -s <source> <dest> <Name|Num>            : SCP file transfer
  sshm -s <source> <dest> <Name|Num> host<N>    : SCP to ServerHost

Options:
  -p    Perform a ping check before connecting
  -P    Override SSH port for the selected target
  --port Override SSH port for the selected target
  -c    Execute a remote command instead of opening interactive shell
  -s    SCP file transfer mode (requires source and destination)
  -h    Print this help message
  -l    List nodes in the selected config
  -g <name|number> Select a config group
  -g    List config groups
  -al   List nodes in all config groups
  -qa   Check SSH and read-only commands in all groups, or the group selected by -g
```

`port` is optional and defaults to `22`. `pass` is optional; omit it to use SSH keys or the standard interactive password prompt.

## Examples

Interactive SSH:

```bash
sshm -p 1 host1
sshm server1 bmc
sshm client1
sshm -P 2222 client1
```

Remote command execution:

```bash
sshm -c "uptime" server1
sshm -c "df -h" 1
sshm -p -c "free -m" client1
sshm -P 2222 -c "hostname" client1
```

SMC access through a server BMC:

```bash
sshm server1 smc
sshm -c "hostname" server1 smc
```

SCP upload and download:

```bash
sshm -s local_file.txt remote:/tmp/ 1
sshm -s remote:/var/log/app.log ./ client1
sshm -s ./local_dir/ remote:/tmp/ server1
sshm -s remote:/var/logs/ ./backup/ server1
```

SCP directly to a server host, or to an SMC through the BMC:

```bash
sshm -s data.txt remote:/tmp/ server1 host1
sshm -s remote:/var/log/syslog ./logs/ server1 host1
sshm -s local_file.txt remote:/tmp/ server1 smc
```

### Fast directory transfers

When the source of a `-s` transfer is a directory, `sshm` streams it with
`tar | ssh tar -x` instead of `scp -r`. A single SSH connection carries the
whole tree, which is dramatically faster than `scp -r` for directories with many
small files over slow links (for example BMC/SMC). This works for both upload and
download. `host<N>` connects directly; only the `smc` sub-target uses a BMC jump.

Compression is decided automatically:

- Small directories (below `SSHM_TAR_THRESHOLD`, default 10MB) are sent without
  gzip — compression would cost CPU for little gain.
- Large directories are gzip-compressed to save bandwidth, unless their contents
  are already mostly compressed (e.g. `.gz`, `.zip`, `.jpg`, `.mp4`), in which
  case gzip is skipped.

A progress bar is shown when `pv` is installed. Relevant environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SSHM_PROGRESS` | `auto` | `auto` shows a `pv` progress bar when `pv` exists; `off` disables it |
| `SSHM_TAR_THRESHOLD` | `10485760` | Directory size (bytes) at/above which gzip is considered |
| `SSHM_FORCE_COMPRESS` | `0` | Set to `1` to always gzip the tar stream |
| `SSHM_NO_COMPRESS` | `0` | Set to `1` to never gzip the tar stream |

If the remote host does not have `tar`, `sshm` automatically falls back to
`scp -r`.

## Error Handling

`sshm` leaves SSH and SCP diagnostics visible and adds a concise summary for common transport failures.

Typical failures include:

- Authentication failures caused by an incorrect username or password.
- Unreachable hosts or refused connections.
- Invalid node numbers, invalid host numbers, unknown targets, or missing arguments.
- Missing or unreadable config files.

Remote command exit codes are preserved. For example, `sshm -c "exit 42" client1` exits with code `42`.

File-transfer failures also return nonzero exit codes, including SCP failures,
remote path probe failures, and directory stream failures. This applies to
name, number, IP, and server sub-target selectors, so shell callers can detect
failed transfers with `if`, `&&`, or `$?`.

## Backend compatibility and tests

`md-reader` and `webscp` import `@ssh-manager/core` directly; their remote file
operations do not execute the Bash `sshm` script. CLI exit-code changes therefore
do not change their HTTP/WebSocket responses or core API behavior.

Run Local QA after editing the repository, without requiring any target machine:

```bash
bash sshm_qa_test.sh
```

By default, QA uses `shared/cli-test-inventory.json` (reserved example IPs and
fake credentials), and opens no remote connections. The transport regression
checks exact SSH/SCP arguments, target and jump ports, password handling, command
quoting, and exit codes. It runs real local tar/gzip streams through a mock SSH
transport, compares uploaded/downloaded trees (including binary files, dotfiles,
empty entries, and quoted paths), and injects failures at both pipeline ends.
SCP fallback is checked with a local copy stand-in. These checks require Bash,
jq, GNU tar/gzip, coreutils, and diff; they do not verify an actual SSH server.
Use `bash sshm_exit_test.sh` to run just this regression group.

The report is written to `sshm_test_report.md`; `SSHM_TEST_REPORT` overrides its
path. Transport, config, and live-QA-mode regressions each occupy a report row with their own
check count. Config checks cover group selection, duplicates, invalid neighbors,
legacy conversion, and installer preservation. Run just those checks with
`bash sshm_config_test.sh`.
`bash sshm_qa_mode_test.sh` checks `-qa` selection, node/sub-target coverage,
status classification, timeouts, noninteractive authentication, and continuation
after failures through mock transports. No local SSH server or test account is
needed. The installer does not run live checks.
Any failed check, timeout, or missing executable makes QA return nonzero.

### Live inventory QA

Use the CLI itself to check the machines in the current private configs:

```bash
sshm -qa                        # all configs in SSHM_CONFIG_DIR or ~/sshm_config
sshm -qa -g tw                  # one group by name
sshm -g 1 -qa                   # one group by number
sshm -qa -g default             # default only (-g 0 is equivalent)
SSHM_QA_TIMEOUT=30 sshm -qa     # per-target timeout, default 15 seconds
```

For `-qa`, omitting `-g` means **all groups**, and `SSHM_CONFIG` is ignored.
Other commands retain their usual default-config behavior. Duplicate group
numbers warn; all-group QA still checks those configs by name. An explicitly
selected ambiguous number is an error. Invalid configs are reported and other
groups continue. Empty configs and SMC-only configs without a server BMC are
reported as configuration failures.

QA checks each client, each server BMC and host, and the standalone SMC through
each server's BMC. It uses the normal CLI selectors and SSH transport, selecting
nodes by index so duplicate IPs or names do not select the wrong credentials.
SMC credentials are not tested as a separate direct connection. Each probe runs
the read-only command `printf 'SSHM_QA_OK\n'` and verifies the returned marker.
It does not write remote files or perform SCP transfers.

The table lists group, node number/name, sub-target, status, and a short reason:

| Status | Meaning |
|---|---|
| `PASS` | SSH and the read-only command succeeded with verified output |
| `AUTH_FAILED` | SSH authentication failed |
| `TIMEOUT` | The probe or SSH connection timed out |
| `CONNECTION_REFUSED` | The SSH connection was refused |
| `CONNECT_FAILED` | Another SSH or jump connection failure |
| `CONFIG_ERROR` | Invalid config, node fields, or sub-target definition |
| `COMMAND_UNSUPPORTED` | SSH responded, but the remote command interface rejected the probe |
| `COMMAND_FAILED` | The expected command output was not confirmed |

An SSH exit code of 0 alone is not a pass: restricted interfaces such as Dell
BMC may report an invalid command while returning 0. Those rows distinguish
command support from connectivity. Passwords and raw remote output are not
included in the report. Probes use configured passwords or available SSH keys;
they do not prompt interactively for missing credentials.

`SSHM_QA_TIMEOUT` accepts 1–300 whole seconds per target, including any BMC jump.
After the deadline, remaining child processes are force-stopped after a two-second
grace period. Checks run sequentially and continue after individual failures.
Exit status is 0 only when every check passes; otherwise it is 1, including an
empty config directory. The final summary counts checks, including config errors.

`-qa` accepts only an optional `-g <name|number>`; combining it with a target,
`-c`, `-s`, `-l`, `-al`, `-p`, or a port override is an error. Bare `-qa -g`
is also an error. Redirect stdout to save a report, e.g. `sshm -qa > qa-report.txt`.

### Optional live transfer regression

The existing developer SSH/SCP tests remain opt-in and use `SSHM_CONFIG` or the normal private
inventory. They connect to selected inventory nodes and transfer test data to
a new remote `/tmp/sshm_qa.*` directory. File and directory round trips are
compared with `cmp`/`diff`; test directories are cleaned up afterward:

```bash
RUN_SSHM_LIVE_TESTS=1 SSHM_CONFIG=/path/to/test-inventory.json bash sshm_qa_test.sh
```

Core and consumer tests remain separate; see the core README for build commands.

## Installation

The recommended way is the bundled installer, which is idempotent and safe to
re-run. It installs dependencies, copies the binary, and seeds a private
inventory without overwriting an existing one. If only `~/note/ssh_remote.json`
exists, it is converted to the new default before the binary is installed, and
the original is retained. Otherwise only the default template is installed;
tw/us templates are never activated automatically:

```bash
./install.sh
```

The installer honors a couple of overrides:

```bash
PREFIX="$HOME/.local" ./install.sh          # install without sudo into a user prefix
SSHM_CONFIG_DIR="$HOME/cfg" ./install.sh    # change where the private inventory is created
```

### Manual installation

Install the script:

```bash
sudo install -m 0755 sshm /usr/local/bin/sshm
```

Create a private inventory outside the repository:

```bash
mkdir -p "$HOME/sshm_config"
cp -n sshm_config/ssh_remote_default.json "$HOME/sshm_config/ssh_remote_default.json"
chmod 600 "$HOME/sshm_config/ssh_remote_default.json"
```

Verify the installation:

```bash
sshm -l
```
