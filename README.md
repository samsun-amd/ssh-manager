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
  sshm [-p] [-c "command"] <IP>                 : SSH to IP
  sshm [-p] [-c "command"] <Name|Num>           : SSH to ServerBMC|Client
  sshm [-p] [-c "command"] <Name|Num> host<N>   : SSH to ServerHost (NIC)

Options:
  -p    Perform a ping check before connecting
  -c    Execute a remote command instead of opening interactive shell
  -h    Print this help message
  -l    List all nodes
```

### Flags
-h (Help): Print usage instructions.  
-l (List Target): Show all servers, indices, and IPs.  
-p (Ping Check): Verify the target is online before attempting SSH.  
-c (Remote Command): Execute a shell command on the target machine and return output.

**Examples:**
```bash
# Interactive SSH
sshm -p 1 host1

# Execute remote command
sshm -c "uptime" server1
sshm -c "df -h" 1
sshm -p -c "free -m" client host1

# Chain remote commands
sshm -c "uptime && free -m && df -h" server2
```

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

---

## 🧪 Testing

### Automated QA Testing

The project includes an automated QA test script that validates all functionality.

**Run Tests:**
```bash
./sshm_qa_test.sh
```

**Features:**
- Automated testing of all core features
- Color-coded test results (✅ PASS / ❌ FAIL)
- Auto-generates detailed Markdown test report
- Comprehensive coverage:
  - Basic functions (help, list, error handling)
  - Remote command execution (`-c` flag)
  - Network connectivity (`-p` ping check)
  - Edge cases (empty commands, exit codes, special characters)

**Test Output Example:**
```
======================================
  SSH Manager (sshm) QA Test Suite
======================================

Checking dependencies...
✓ jq installed
✓ sshpass installed

=== BASIC FUNCTION TESTS ===
Running: Help Display
✅ PASS

Running: List All Nodes
✅ PASS
...

======================================
           TEST SUMMARY
======================================
Total Tests: 17
Passed: 17
Failed: 0
Pass Rate: 100.0%

✅ ALL TESTS PASSED!
```

**Requirements for Testing:**
- Valid `ssh_remote.json` configuration file
- Network access to configured hosts
- Dependencies: `jq`, `sshpass`, `timeout`

**Test Report:**
After running tests, a detailed report is generated at `sshm_test_report.md` containing:
- Test execution summary
- Detailed results for each test case
- Pass/fail statistics by category
- Command outputs and validation results
