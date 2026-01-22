#!/bin/bash

# SSH Manager (sshm) QA Test Script
# Auto-generates test report in Markdown format

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSHM="$SCRIPT_DIR/sshm"
TEST_REPORT="$SCRIPT_DIR/sshm_test_report.md"
TEST_LOG="/tmp/sshm_test_$(date +%s).log"

# Colors
GREEN='\033[1;32m'
RED='\033[1;31m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
NC='\033[0m' # No Color

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Test categories
BASIC_TESTS_TOTAL=0
BASIC_TESTS_PASSED=0
ERROR_TESTS_TOTAL=0
ERROR_TESTS_PASSED=0
COMMAND_TESTS_TOTAL=0
COMMAND_TESTS_PASSED=0
SCP_TESTS_TOTAL=0
SCP_TESTS_PASSED=0
NETWORK_TESTS_TOTAL=0
NETWORK_TESTS_PASSED=0
EDGE_TESTS_TOTAL=0
EDGE_TESTS_PASSED=0

# Arrays to store test results
declare -a TEST_NAMES
declare -a TEST_COMMANDS
declare -a TEST_RESULTS
declare -a TEST_OUTPUTS
declare -a TEST_CATEGORIES

# Function to run a test
run_test() {
    local test_name="$1"
    local test_command="$2"
    local expected_result="$3"
    local category="$4"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    echo -e "${BLUE}Running: $test_name${NC}"
    
    # Execute command and capture output
    local output
    local exit_code
    output=$(eval "$test_command" 2>&1)
    exit_code=$?
    
    # Store results
    TEST_NAMES+=("$test_name")
    TEST_COMMANDS+=("$test_command")
    TEST_OUTPUTS+=("$output")
    TEST_CATEGORIES+=("$category")
    
    # Check result based on expected outcome
    local test_passed=false
    case "$expected_result" in
        "success")
            if [[ $exit_code -eq 0 ]]; then
                test_passed=true
            fi
            ;;
        "error")
            if [[ $exit_code -ne 0 ]]; then
                test_passed=true
            fi
            ;;
        "exit_code:"*)
            local expected_code="${expected_result#exit_code:}"
            if [[ $exit_code -eq $expected_code ]]; then
                test_passed=true
            fi
            ;;
        "contains:"*)
            local expected_text="${expected_result#contains:}"
            if echo "$output" | grep -q "$expected_text"; then
                test_passed=true
            fi
            ;;
    esac
    
    if $test_passed; then
        TEST_RESULTS+=("PASS")
        PASSED_TESTS=$((PASSED_TESTS + 1))
        echo -e "${GREEN}✅ PASS${NC}\n"
        
        # Update category counters
        case "$category" in
            "basic") BASIC_TESTS_PASSED=$((BASIC_TESTS_PASSED + 1)) ;;
            "error") ERROR_TESTS_PASSED=$((ERROR_TESTS_PASSED + 1)) ;;
            "command") COMMAND_TESTS_PASSED=$((COMMAND_TESTS_PASSED + 1)) ;;
            "scp") SCP_TESTS_PASSED=$((SCP_TESTS_PASSED + 1)) ;;
            "network") NETWORK_TESTS_PASSED=$((NETWORK_TESTS_PASSED + 1)) ;;
            "edge") EDGE_TESTS_PASSED=$((EDGE_TESTS_PASSED + 1)) ;;
        esac
    else
        TEST_RESULTS+=("FAIL")
        FAILED_TESTS=$((FAILED_TESTS + 1))
        echo -e "${RED}❌ FAIL${NC}"
        echo -e "Expected: $expected_result, Got exit code: $exit_code\n"
        
    fi
    
    # Update category totals
    case "$category" in
        "basic") BASIC_TESTS_TOTAL=$((BASIC_TESTS_TOTAL + 1)) ;;
        "error") ERROR_TESTS_TOTAL=$((ERROR_TESTS_TOTAL + 1)) ;;
        "command") COMMAND_TESTS_TOTAL=$((COMMAND_TESTS_TOTAL + 1)) ;;
        "scp") SCP_TESTS_TOTAL=$((SCP_TESTS_TOTAL + 1)) ;;
        "network") NETWORK_TESTS_TOTAL=$((NETWORK_TESTS_TOTAL + 1)) ;;
        "edge") EDGE_TESTS_TOTAL=$((EDGE_TESTS_TOTAL + 1)) ;;
    esac
}

# Function to generate report
generate_report() {
    local pass_rate=$(awk "BEGIN {printf \"%.1f\", ($PASSED_TESTS/$TOTAL_TESTS)*100}")
    
    cat > "$TEST_REPORT" << 'EOF'
# SSH Manager (sshm) QA Test Report

**Test Date:** $(date '+%B %d, %Y %H:%M:%S')  
**Tester:** Automated QA Script  
**Version:** sshm with `-c` remote command execution feature  
**Test Environment:** $(pwd)  

---

## 📋 Executive Summary

| Category | Total Tests | Passed | Failed | Pass Rate |
|----------|-------------|--------|--------|-----------|
| **Overall** | **${TOTAL_TESTS}** | **${PASSED_TESTS}** | **${FAILED_TESTS}** | **${pass_rate}%** |
| Basic Functions | ${BASIC_TESTS_TOTAL} | ${BASIC_TESTS_PASSED} | $((BASIC_TESTS_TOTAL - BASIC_TESTS_PASSED)) | $(awk "BEGIN {printf \"%.1f\", ($BASIC_TESTS_PASSED/$BASIC_TESTS_TOTAL)*100}")% |
| Error Handling | ${ERROR_TESTS_TOTAL} | ${ERROR_TESTS_PASSED} | $((ERROR_TESTS_TOTAL - ERROR_TESTS_PASSED)) | $(awk "BEGIN {printf \"%.1f\", ($ERROR_TESTS_PASSED/$ERROR_TESTS_TOTAL)*100}")% |
| Remote Command (\`-c\`) | ${COMMAND_TESTS_TOTAL} | ${COMMAND_TESTS_PASSED} | $((COMMAND_TESTS_TOTAL - COMMAND_TESTS_PASSED)) | $(awk "BEGIN {printf \"%.1f\", ($COMMAND_TESTS_PASSED/$COMMAND_TESTS_TOTAL)*100}")% |
| SCP Transfer (\`-s\`) | ${SCP_TESTS_TOTAL} | ${SCP_TESTS_PASSED} | $((SCP_TESTS_TOTAL - SCP_TESTS_PASSED)) | $(awk "BEGIN {printf \"%.1f\", ($SCP_TESTS_PASSED/$SCP_TESTS_TOTAL)*100}")% |
| Network & Ping | ${NETWORK_TESTS_TOTAL} | ${NETWORK_TESTS_PASSED} | $((NETWORK_TESTS_TOTAL - NETWORK_TESTS_PASSED)) | $(awk "BEGIN {printf \"%.1f\", ($NETWORK_TESTS_PASSED/$NETWORK_TESTS_TOTAL)*100}")% |
| Edge Cases | ${EDGE_TESTS_TOTAL} | ${EDGE_TESTS_PASSED} | $((EDGE_TESTS_TOTAL - EDGE_TESTS_PASSED)) | $(awk "BEGIN {printf \"%.1f\", ($EDGE_TESTS_PASSED/$EDGE_TESTS_TOTAL)*100}")% |

---

## 📝 Detailed Test Results

EOF

    # Add detailed results
    for i in "${!TEST_NAMES[@]}"; do
        local status_icon="✅"
        [[ "${TEST_RESULTS[$i]}" == "FAIL" ]] && status_icon="❌"
        
        cat >> "$TEST_REPORT" << EOF

### $status_icon TEST $((i+1)): ${TEST_NAMES[$i]}
**Command:** \`${TEST_COMMANDS[$i]}\`  
**Category:** ${TEST_CATEGORIES[$i]}  
**Result:** ${TEST_RESULTS[$i]}  

\`\`\`
${TEST_OUTPUTS[$i]}
\`\`\`

---
EOF
    done
    
    # Add conclusion
    cat >> "$TEST_REPORT" << EOF

## 🏁 Conclusion

**Pass Rate:** ${pass_rate}%  
**Total Tests:** ${TOTAL_TESTS}  
**Passed:** ${PASSED_TESTS}  
**Failed:** ${FAILED_TESTS}  

EOF

    if [[ $FAILED_TESTS -eq 0 ]]; then
        cat >> "$TEST_REPORT" << EOF
**Status:** ✅ ALL TESTS PASSED - PRODUCTION READY

The \`sshm\` tool has passed all tests and is ready for production use.
EOF
    else
        cat >> "$TEST_REPORT" << EOF
**Status:** ⚠️ SOME TESTS FAILED

Please review the failed tests above and address the issues before production deployment.
EOF
    fi
    
    cat >> "$TEST_REPORT" << EOF

---

**Report Generated:** $(date '+%B %d, %Y %H:%M:%S')  
**Test Script:** sshm_qa_test.sh  
EOF
}

# Main test execution
echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}  SSH Manager (sshm) QA Test Suite${NC}"
echo -e "${BLUE}======================================${NC}\n"

# Check dependencies
echo -e "${BLUE}Checking dependencies...${NC}"
for cmd in jq sshpass; do
    if command -v $cmd &> /dev/null; then
        echo -e "${GREEN}✓${NC} $cmd installed"
    else
        echo -e "${RED}✗${NC} $cmd missing"
    fi
done
echo ""

# BASIC FUNCTION TESTS
echo -e "${YELLOW}=== BASIC FUNCTION TESTS ===${NC}\n"

run_test "Help Display" \
    "timeout 5 $SSHM -h > /dev/null" \
    "success" \
    "basic"

run_test "List All Nodes" \
    "timeout 5 $SSHM -l > /dev/null" \
    "success" \
    "basic"

run_test "No Arguments" \
    "timeout 5 $SSHM > /dev/null" \
    "success" \
    "basic"

# ERROR HANDLING TESTS
echo -e "${YELLOW}=== ERROR HANDLING TESTS ===${NC}\n"

run_test "Invalid Number" \
    "timeout 5 $SSHM 99 2>&1" \
    "error" \
    "error"

run_test "Invalid Name" \
    "timeout 5 $SSHM nonexistent 2>&1" \
    "error" \
    "error"

run_test "Invalid IP" \
    "timeout 5 $SSHM 192.168.99.99 2>&1" \
    "error" \
    "error"

run_test "Invalid Host Target" \
    "timeout 5 $SSHM 1 host99 2>&1" \
    "error" \
    "error"

# REMOTE COMMAND TESTS (with real targets from config)
echo -e "${YELLOW}=== REMOTE COMMAND TESTS ===${NC}\n"

run_test "Remote Command on Client (Name)" \
    "timeout 10 $SSHM -c 'hostname' obmc-18.04 2>&1" \
    "success" \
    "command"

run_test "Remote Command on Client (Number)" \
    "timeout 10 $SSHM -c 'whoami' 4 2>&1" \
    "success" \
    "command"

run_test "Remote Command on Server BMC" \
    "timeout 10 $SSHM -c 'uptime' 2 2>&1" \
    "success" \
    "command"

run_test "Remote Command on Server Host" \
    "timeout 10 $SSHM -c 'uname -r' gtmi300x host1 2>&1" \
    "success" \
    "command"

run_test "Remote Command via IP" \
    "timeout 10 $SSHM -c 'pwd' 10.95.37.84 2>&1" \
    "success" \
    "command"

run_test "Complex Remote Command" \
    "timeout 10 $SSHM -c 'df -h | grep -E \"^/dev\" | head -1' 4 2>&1" \
    "success" \
    "command"

# SCP TRANSFER TESTS
echo -e "${YELLOW}=== SCP TRANSFER TESTS ===${NC}\n"

# Create test files and directories
TEST_FILE="/tmp/sshm_test_upload_$(date +%s).txt"
TEST_DIR="/tmp/sshm_test_dir_$(date +%s)"
DOWNLOAD_FILE="/tmp/sshm_download_$(date +%s).txt"
DOWNLOAD_DIR="/tmp/sshm_download_dir_$(date +%s)"

echo "Test content $(date)" > "$TEST_FILE"
mkdir -p "$TEST_DIR"
echo "Dir test $(date)" > "$TEST_DIR/file.txt"
echo "Dir test2 $(date)" > "$TEST_DIR/file2.txt"

run_test "SCP Upload Single File (by Number)" \
    "timeout 15 $SSHM -s $TEST_FILE remote:/tmp/ 4 2>&1" \
    "success" \
    "scp"

run_test "SCP Download Single File (by Number)" \
    "timeout 15 $SSHM -s remote:/tmp/$(basename $TEST_FILE) $DOWNLOAD_FILE 4 2>&1" \
    "success" \
    "scp"

run_test "SCP Upload Directory (by Name)" \
    "timeout 15 $SSHM -s $TEST_DIR/ remote:/tmp/ obmc-18.04 2>&1" \
    "success" \
    "scp"

run_test "SCP Download Directory (by Name)" \
    "timeout 15 $SSHM -s remote:/tmp/$(basename $TEST_DIR) $DOWNLOAD_DIR obmc-18.04 2>&1" \
    "success" \
    "scp"

run_test "SCP Upload to Server Host" \
    "timeout 15 $SSHM -s $TEST_FILE remote:/tmp/ gtmi300x host1 2>&1" \
    "success" \
    "scp"

run_test "SCP Download from Server Host" \
    "timeout 15 $SSHM -s remote:/tmp/$(basename $TEST_FILE) /tmp/sshm_host_download_$(date +%s).txt gtmi300x host1 2>&1" \
    "success" \
    "scp"

run_test "SCP Invalid Source File" \
    "timeout 10 $SSHM -s /nonexistent/file.txt remote:/tmp/ 4 2>&1" \
    "error" \
    "scp"

run_test "SCP Missing remote: Prefix" \
    "timeout 10 $SSHM -s /tmp/file.txt /tmp/dest 4 2>&1" \
    "error" \
    "scp"

run_test "SCP Missing Destination Argument" \
    "timeout 10 $SSHM -s 4 2>&1" \
    "error" \
    "scp"

# Cleanup test files
rm -f "$TEST_FILE" "$DOWNLOAD_FILE" /tmp/sshm_host_download_*.txt
rm -rf "$TEST_DIR" "$DOWNLOAD_DIR"

# NETWORK TESTS
echo -e "${YELLOW}=== NETWORK TESTS ===${NC}\n"

run_test "Ping Check with Command" \
    "timeout 15 $SSHM -p -c 'echo success' 4 2>&1" \
    "contains:ONLINE" \
    "network"

# EDGE CASE TESTS
echo -e "${YELLOW}=== EDGE CASE TESTS ===${NC}\n"

run_test "Empty Command String" \
    "timeout 10 $SSHM -c '' 4 2>&1" \
    "error" \
    "edge"

run_test "Exit Code Propagation" \
    "timeout 10 $SSHM -c 'exit 42' 4 2>&1; test \$? -eq 42" \
    "success" \
    "edge"

run_test "Command with Special Characters" \
    "timeout 10 $SSHM -c 'echo \"Test: \\\$HOME\"' 4 2>&1" \
    "success" \
    "edge"

# Generate report
echo -e "\n${BLUE}Generating test report...${NC}"
generate_report

# Summary
echo -e "\n${BLUE}======================================${NC}"
echo -e "${BLUE}           TEST SUMMARY${NC}"
echo -e "${BLUE}======================================${NC}"
echo -e "Total Tests: ${TOTAL_TESTS}"
echo -e "${GREEN}Passed: ${PASSED_TESTS}${NC}"
echo -e "${RED}Failed: ${FAILED_TESTS}${NC}"
echo -e "Pass Rate: $(awk "BEGIN {printf \"%.1f\", ($PASSED_TESTS/$TOTAL_TESTS)*100}")%"
echo -e "\n${BLUE}Report saved to:${NC} $TEST_REPORT\n"

# Exit with appropriate code
if [[ $FAILED_TESTS -eq 0 ]]; then
    echo -e "${GREEN}✅ ALL TESTS PASSED!${NC}\n"
    exit 0
else
    echo -e "${RED}❌ SOME TESTS FAILED${NC}\n"
    exit 1
fi
