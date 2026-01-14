# SSH Manager (sshm)

A lightweight Bash utility to manage and automate SSH connections to multiple servers, BMCs, and clients using a JSON-based inventory.

## 🛠 Prerequisites

Ensure you have the following tools installed on your system:

bash

```
sudo apt update
sudo apt install jq sshpass fping -y
```

## 📂 Configuration
The script manages connections based on a JSON file. You need to provide your own JOSN file path, The example here is "./ssh_remote.json"
### JSON Schema
The inventory supports two node types: server (for machines with BMC and multiple NICs) and client (for standalone Linux machines).JSON
```
[
  {
    "type": "server",
    "name": "DB_Server_01",
    "bmc": {
      "ip": "x.x.x.x",
      "user": "admin",
      "pass": "password"
    },
    "hosts": [
      { "ip": "x.x.x.x", "user": "root", "pass": "rootpass" },
      { "ip": "x.x.x.x", "user": "admin", "pass": "adminpass" }
    ],
    "note": "Primary Database"
  },
  {
    "type": "client",
    "name": "Dev_Workstation",
    "ip": "x.x.x.x",
    "user": "username",
    "pass": "mypassword",
    "note": "Local dev box"
  }
]
```
## 📖 Usage
### Basic Commands
```
SSH Manager - Remote Access Tool
--------------------------------
Usage:
  sshm [-p] <IP>                 : SSH to IP
  sshm [-p] <Name|Num>           : SSH to ServerBMC|Client
  sshm [-p] <Name|Num> host<N>   : SSH to ServerHost (NIC)

Options:
  -p    Perform a ping check before connecting
  -h    Print this help message
  -l    List all nodes
```

### Flags
-h (Help): Print usage instructions.  
-l (List Target): Show all servers, indices, and IPs.  
-p (Ping Check): Verify the target is online before attempting SSH.
Example: sshm -p 1 host1

### Example

- List all node
```
➜  ssh-manager git:(main) ✗ ./sshm -l
Num  Type    Name     IP(s)
---  ---     ---      ---
1    Server  server1  BMC: x.x.x.x, Hosts: x.x.x.x
2    Server  server2  BMC: x.x.x.x, Hosts: x.x.x.x,x.x.x.x
3    Client  client   x.x.x.x
```

## 🔧 Installation
1. Clone the sshm.sh.
2. Change the mod of the script:
Bash
```
chmod +x sshm.sh
```
3. Configure you own JSON file.
4. Configure the JSON file path in the script.
5. Verify: Type sshm -l to ensure it is working correctly.
