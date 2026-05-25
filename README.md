# SSH Manager (sshm)

`sshm` is a lightweight Bash utility for managing SSH, jump-host SSH, and SCP workflows from a JSON inventory.

## Requirements

Install the required tools:

```bash
sudo apt update
sudo apt install jq openssh-client sshpass fping -y
```

`fping` is optional. If it is unavailable, `sshm -p` falls back to `ping`. `sshpass` is only used for inventory entries that store `pass`.

## Configuration

The repository `ssh_remote.json` is an example file only. Do not commit real credentials, production IP addresses, or private inventory data.

`sshm` resolves its configuration in this order:

1. `SSHM_CONFIG`, when set.
2. `$HOME/note/ssh_remote.json`, for deployed local usage.
3. `ssh_remote.json` in the same directory as the `sshm` script, for repository examples and local development.

Examples:

```bash
SSHM_CONFIG=/path/to/ssh_remote.json ./sshm -l
SSHM_CONFIG=/path/to/ssh_remote.json ./sshm -c "hostname" server1
```

## JSON Inventory Schema

The inventory supports these node types:

- `server`: a platform with one BMC and optional host NICs.
- `client`: a standalone SSH target.
- `smc`: an SMC target that can be accessed through a server BMC jump host.

```json
[
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
  -l    List all nodes
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

SCP through a server host or SMC path:

```bash
sshm -s data.txt remote:/tmp/ server1 host1
sshm -s remote:/var/log/syslog ./logs/ server1 host1
sshm -s local_file.txt remote:/tmp/ server1 smc
```

## Error Handling

`sshm` leaves SSH and SCP diagnostics visible and adds a concise summary for common transport failures.

Typical failures include:

- Authentication failures caused by an incorrect username or password.
- Unreachable hosts or refused connections.
- Invalid node numbers, invalid host numbers, unknown targets, or missing arguments.
- Missing or unreadable config files.

Remote command exit codes are preserved. For example, `sshm -c "exit 42" client1` exits with code `42`.

## Installation

Install the script:

```bash
sudo install -m 0755 sshm /usr/local/bin/sshm
```

Create a private inventory outside the repository:

```bash
mkdir -p "$HOME/note"
cp ssh_remote.json "$HOME/note/ssh_remote.json"
chmod 600 "$HOME/note/ssh_remote.json"
```

Verify the installation:

```bash
sshm -l
```
