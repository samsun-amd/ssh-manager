#!/bin/bash

# SSH Manager (sshm) QA Test Script
# Generates a Markdown report without embedding private inventory contents.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSHM="$SCRIPT_DIR/sshm"
TEST_REPORT="$SCRIPT_DIR/sshm_test_report.md"

if [[ -n "${SSHM_CONFIG:-}" ]]; then
    CONFIG_FILE="$SSHM_CONFIG"
elif [[ -r "$HOME/note/ssh_remote.json" ]]; then
    CONFIG_FILE="$HOME/note/ssh_remote.json"
else
    CONFIG_FILE="$SCRIPT_DIR/ssh_remote.json"
fi

GREEN='\033[1;32m'
RED='\033[1;31m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
NC='\033[0m'

TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
SKIPPED_TESTS=0

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

declare -a TEST_NAMES
declare -a TEST_COMMANDS
declare -a TEST_RESULTS
declare -a TEST_OUTPUTS
declare -a TEST_CATEGORIES

percent() {
    local passed=$1 total=$2
    if [[ $total -eq 0 ]]; then
        printf "0.0"
    else
        awk "BEGIN {printf \"%.1f\", ($passed/$total)*100}"
    fi
}

sanitize_text() {
    sed -E \
        -e 's/([0-9]{1,3}\.){3}[0-9]{1,3}/x.x.x.x/g' \
        -e 's#SSHM_CONFIG=[^ ]+#SSHM_CONFIG=<config>#g'
}

command_to_string() {
    printf "%q " "$@"
}

increment_category_total() {
    local category=$1
    case "$category" in
        basic) BASIC_TESTS_TOTAL=$((BASIC_TESTS_TOTAL + 1)) ;;
        error) ERROR_TESTS_TOTAL=$((ERROR_TESTS_TOTAL + 1)) ;;
        command) COMMAND_TESTS_TOTAL=$((COMMAND_TESTS_TOTAL + 1)) ;;
        scp) SCP_TESTS_TOTAL=$((SCP_TESTS_TOTAL + 1)) ;;
        network) NETWORK_TESTS_TOTAL=$((NETWORK_TESTS_TOTAL + 1)) ;;
        edge) EDGE_TESTS_TOTAL=$((EDGE_TESTS_TOTAL + 1)) ;;
    esac
}

increment_category_passed() {
    local category=$1
    case "$category" in
        basic) BASIC_TESTS_PASSED=$((BASIC_TESTS_PASSED + 1)) ;;
        error) ERROR_TESTS_PASSED=$((ERROR_TESTS_PASSED + 1)) ;;
        command) COMMAND_TESTS_PASSED=$((COMMAND_TESTS_PASSED + 1)) ;;
        scp) SCP_TESTS_PASSED=$((SCP_TESTS_PASSED + 1)) ;;
        network) NETWORK_TESTS_PASSED=$((NETWORK_TESTS_PASSED + 1)) ;;
        edge) EDGE_TESTS_PASSED=$((EDGE_TESTS_PASSED + 1)) ;;
    esac
}

record_test() {
    local test_name=$1 command_display=$2 result=$3 output=$4 category=$5

    TEST_NAMES+=("$test_name")
    TEST_COMMANDS+=("$command_display")
    TEST_RESULTS+=("$result")
    TEST_OUTPUTS+=("$output")
    TEST_CATEGORIES+=("$category")
}

run_test() {
    local test_name=$1 expected_result=$2 category=$3
    shift 3

    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    increment_category_total "$category"

    echo -e "${BLUE}Running: $test_name${NC}"

    local command_display output exit_code sanitized_output test_passed expected_text expected_code
    command_display=$(command_to_string "$@" | sanitize_text)
    output=$("$@" 2>&1)
    exit_code=$?
    sanitized_output=$(printf "%s" "$output" | sanitize_text)

    test_passed=false
    case "$expected_result" in
        success)
            [[ $exit_code -eq 0 ]] && test_passed=true
            ;;
        error)
            [[ $exit_code -ne 0 ]] && test_passed=true
            ;;
        exit_code:*)
            expected_code="${expected_result#exit_code:}"
            [[ $exit_code -eq $expected_code ]] && test_passed=true
            ;;
        contains:*)
            expected_text="${expected_result#contains:}"
            grep -Fq "$expected_text" <<< "$output" && test_passed=true
            ;;
        error_contains:*)
            expected_text="${expected_result#error_contains:}"
            if [[ $exit_code -ne 0 ]] && grep -Fq "$expected_text" <<< "$output"; then
                test_passed=true
            fi
            ;;
    esac

    if [[ "$test_passed" == "true" ]]; then
        PASSED_TESTS=$((PASSED_TESTS + 1))
        increment_category_passed "$category"
        record_test "$test_name" "$command_display" "PASS" "$sanitized_output" "$category"
        echo -e "${GREEN}PASS${NC}\n"
    else
        FAILED_TESTS=$((FAILED_TESTS + 1))
        record_test "$test_name" "$command_display" "FAIL" "$sanitized_output" "$category"
        echo -e "${RED}FAIL${NC}"
        echo -e "Expected: $expected_result, exit code: $exit_code\n"
    fi
}

skip_test() {
    local test_name=$1 reason=$2 category=$3

    SKIPPED_TESTS=$((SKIPPED_TESTS + 1))
    record_test "$test_name" "N/A" "SKIP" "$reason" "$category"
    echo -e "${YELLOW}Skipping: $test_name - $reason${NC}\n"
}

first_jq_value() {
    local query=$1
    jq -r "$query" "$CONFIG_FILE" | sed -n '1p'
}

generate_report() {
    local pass_rate
    pass_rate=$(percent "$PASSED_TESTS" "$TOTAL_TESTS")

    {
        cat << EOF
# SSH Manager (sshm) QA Test Report

**Test Date:** $(date '+%B %d, %Y %H:%M:%S')
**Tester:** Automated QA Script
**Config Source:** Sanitized
**Live SSH/SCP Tests:** ${RUN_SSHM_LIVE_TESTS:-0}

---

## Executive Summary

| Category | Total Tests | Passed | Failed | Pass Rate |
|----------|-------------|--------|--------|-----------|
| **Overall** | **${TOTAL_TESTS}** | **${PASSED_TESTS}** | **${FAILED_TESTS}** | **${pass_rate}%** |
| Basic Functions | ${BASIC_TESTS_TOTAL} | ${BASIC_TESTS_PASSED} | $((BASIC_TESTS_TOTAL - BASIC_TESTS_PASSED)) | $(percent "$BASIC_TESTS_PASSED" "$BASIC_TESTS_TOTAL")% |
| Error Handling | ${ERROR_TESTS_TOTAL} | ${ERROR_TESTS_PASSED} | $((ERROR_TESTS_TOTAL - ERROR_TESTS_PASSED)) | $(percent "$ERROR_TESTS_PASSED" "$ERROR_TESTS_TOTAL")% |
| Remote Command | ${COMMAND_TESTS_TOTAL} | ${COMMAND_TESTS_PASSED} | $((COMMAND_TESTS_TOTAL - COMMAND_TESTS_PASSED)) | $(percent "$COMMAND_TESTS_PASSED" "$COMMAND_TESTS_TOTAL")% |
| SCP Transfer | ${SCP_TESTS_TOTAL} | ${SCP_TESTS_PASSED} | $((SCP_TESTS_TOTAL - SCP_TESTS_PASSED)) | $(percent "$SCP_TESTS_PASSED" "$SCP_TESTS_TOTAL")% |
| Network & Ping | ${NETWORK_TESTS_TOTAL} | ${NETWORK_TESTS_PASSED} | $((NETWORK_TESTS_TOTAL - NETWORK_TESTS_PASSED)) | $(percent "$NETWORK_TESTS_PASSED" "$NETWORK_TESTS_TOTAL")% |
| Edge Cases | ${EDGE_TESTS_TOTAL} | ${EDGE_TESTS_PASSED} | $((EDGE_TESTS_TOTAL - EDGE_TESTS_PASSED)) | $(percent "$EDGE_TESTS_PASSED" "$EDGE_TESTS_TOTAL")% |

Skipped tests: ${SKIPPED_TESTS}

---

## Detailed Test Results

EOF

        for i in "${!TEST_NAMES[@]}"; do
            cat << EOF
### TEST $((i + 1)): ${TEST_NAMES[$i]}

**Command:** \`${TEST_COMMANDS[$i]}\`
**Category:** ${TEST_CATEGORIES[$i]}
**Result:** ${TEST_RESULTS[$i]}

\`\`\`text
${TEST_OUTPUTS[$i]}
\`\`\`

---

EOF
        done

        cat << EOF
## Conclusion

**Pass Rate:** ${pass_rate}%
**Total Tests:** ${TOTAL_TESTS}
**Passed:** ${PASSED_TESTS}
**Failed:** ${FAILED_TESTS}
**Skipped:** ${SKIPPED_TESTS}

EOF

        if [[ $FAILED_TESTS -eq 0 ]]; then
            echo "**Status:** ALL EXECUTED TESTS PASSED"
        else
            echo "**Status:** SOME TESTS FAILED"
        fi
    } > "$TEST_REPORT"
}

if [[ ! -r "$CONFIG_FILE" ]]; then
    echo -e "${RED}Config file is not readable: $CONFIG_FILE${NC}" >&2
    exit 1
fi

if ! jq -e 'type == "array"' "$CONFIG_FILE" > /dev/null; then
    echo -e "${RED}Config file must be a valid JSON array: $CONFIG_FILE${NC}" >&2
    exit 1
fi

CLIENT_NAME=$(first_jq_value '.[] | select(.type == "client") | .name')
CLIENT_INDEX=$(first_jq_value 'to_entries[] | select(.value.type == "client") | (.key + 1)')
SERVER_NAME=$(first_jq_value '.[] | select(.type == "server") | .name')
SERVER_INDEX=$(first_jq_value 'to_entries[] | select(.value.type == "server") | (.key + 1)')
SERVER_WITH_HOST_NAME=$(first_jq_value '.[] | select(.type == "server" and ((.hosts // []) | length > 0)) | .name')
WRONG_AUTH_NAME=$(first_jq_value '.[] | select(.type == "client" and (((.name // "") | test("^fake-|wrong|invalid"; "i")) or ((.note // "") | test("fail|wrong|invalid"; "i")))) | .name')

echo -e "${BLUE}======================================${NC}"
echo -e "${BLUE}  SSH Manager (sshm) QA Test Suite${NC}"
echo -e "${BLUE}======================================${NC}\n"

echo -e "${BLUE}Checking dependencies...${NC}"
for cmd in jq sshpass; do
    if command -v "$cmd" &> /dev/null; then
        echo -e "${GREEN}OK${NC} $cmd installed"
    else
        echo -e "${RED}MISSING${NC} $cmd"
    fi
done
echo ""

echo -e "${YELLOW}=== BASIC FUNCTION TESTS ===${NC}\n"
run_test "Help Display" success basic timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -h
run_test "List All Nodes" success basic timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -l
run_test "No Arguments" success basic timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM"

echo -e "${YELLOW}=== ERROR HANDLING TESTS ===${NC}\n"
run_test "Invalid Number" error error timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" 99999
run_test "Zero Number" error_contains:"Node number must be greater than 0" error timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" 0
run_test "Invalid Name" error error timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" nonexistent-target
run_test "Unknown Option" error error timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -z
run_test "List Extra Argument" error error timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -l extra
run_test "Too Many Arguments" error error timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" 1 2 3
run_test "Missing Command Argument" error error timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -c
run_test "Missing SCP Destination Argument" error error timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -s local-only

if [[ -n "$SERVER_INDEX" ]]; then
    run_test "Invalid Host Target" error error timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" "$SERVER_INDEX" host99
    run_test "Host Zero" error_contains:"Host number must be greater than 0" error timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" "$SERVER_INDEX" host0
    run_test "Unknown Target" error error timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" "$SERVER_INDEX" unknown
else
    skip_test "Invalid Host Target" "No server node in config" error
    skip_test "Host Zero" "No server node in config" error
    skip_test "Unknown Target" "No server node in config" error
fi

if [[ -n "$CLIENT_NAME" ]]; then
    run_test "Empty Command String" error edge timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -c "" "$CLIENT_NAME"
    run_test "SCP Missing remote Prefix" error scp timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -s /tmp/source /tmp/dest "$CLIENT_NAME"
    run_test "SCP Invalid Source File" error scp timeout 5 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -s /nonexistent/sshm-file remote:/tmp/ "$CLIENT_NAME"
else
    skip_test "Empty Command String" "No client node in config" edge
    skip_test "SCP Missing remote Prefix" "No client node in config" scp
    skip_test "SCP Invalid Source File" "No client node in config" scp
fi

echo -e "${YELLOW}=== LIVE SSH/SCP TESTS ===${NC}\n"
if [[ "${RUN_SSHM_LIVE_TESTS:-0}" == "1" ]]; then
    if [[ -n "$CLIENT_NAME" ]]; then
        run_test "Remote Command on Client Name" success command timeout 15 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -c "hostname" "$CLIENT_NAME"
        run_test "Exit Code Propagation" exit_code:42 edge timeout 15 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -c "exit 42" "$CLIENT_NAME"
        run_test "Ping Check with Command" contains:ONLINE network timeout 15 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -p -c "echo success" "$CLIENT_NAME"

        TEST_FILE="/tmp/sshm_test_upload_$(date +%s).txt"
        DOWNLOAD_FILE="/tmp/sshm_download_$(date +%s).txt"
        printf "Test content %s\n" "$(date)" > "$TEST_FILE"
        run_test "SCP Upload Single File" success scp timeout 20 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -s "$TEST_FILE" remote:/tmp/ "$CLIENT_NAME"
        run_test "SCP Download Single File" success scp timeout 20 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -s "remote:/tmp/$(basename "$TEST_FILE")" "$DOWNLOAD_FILE" "$CLIENT_NAME"
        rm -f "$TEST_FILE" "$DOWNLOAD_FILE"
    else
        skip_test "Remote Command on Client Name" "No client node in config" command
        skip_test "Exit Code Propagation" "No client node in config" edge
        skip_test "Ping Check with Command" "No client node in config" network
        skip_test "SCP Upload Single File" "No client node in config" scp
        skip_test "SCP Download Single File" "No client node in config" scp
    fi

    if [[ -n "$CLIENT_INDEX" ]]; then
        run_test "Remote Command on Client Number" success command timeout 15 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -c "whoami" "$CLIENT_INDEX"
    else
        skip_test "Remote Command on Client Number" "No client node in config" command
    fi

    if [[ -n "$SERVER_NAME" ]]; then
        run_test "Remote Command on Server BMC" success command timeout 15 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -c "uptime" "$SERVER_NAME"
    else
        skip_test "Remote Command on Server BMC" "No server node in config" command
    fi

    if [[ -n "$SERVER_WITH_HOST_NAME" ]]; then
        run_test "Remote Command on Server Host" success command timeout 15 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -c "uname -r" "$SERVER_WITH_HOST_NAME" host1
    else
        skip_test "Remote Command on Server Host" "No server host node in config" command
    fi

    if [[ -n "$WRONG_AUTH_NAME" ]]; then
        run_test "Wrong Username Authentication Error" error_contains:"SSH authentication failed" error timeout 15 env "SSHM_CONFIG=$CONFIG_FILE" "$SSHM" -c "whoami" "$WRONG_AUTH_NAME"
    else
        skip_test "Wrong Username Authentication Error" "No wrong-auth client marker found in config" error
    fi
else
    skip_test "Remote Command on Client Name" "Set RUN_SSHM_LIVE_TESTS=1 to enable live SSH tests" command
    skip_test "Remote Command on Client Number" "Set RUN_SSHM_LIVE_TESTS=1 to enable live SSH tests" command
    skip_test "Remote Command on Server BMC" "Set RUN_SSHM_LIVE_TESTS=1 to enable live SSH tests" command
    skip_test "Remote Command on Server Host" "Set RUN_SSHM_LIVE_TESTS=1 to enable live SSH tests" command
    skip_test "Wrong Username Authentication Error" "Set RUN_SSHM_LIVE_TESTS=1 to enable live SSH tests" error
    skip_test "Ping Check with Command" "Set RUN_SSHM_LIVE_TESTS=1 to enable live SSH tests" network
    skip_test "SCP Upload Single File" "Set RUN_SSHM_LIVE_TESTS=1 to enable live SSH tests" scp
    skip_test "SCP Download Single File" "Set RUN_SSHM_LIVE_TESTS=1 to enable live SSH tests" scp
    skip_test "Exit Code Propagation" "Set RUN_SSHM_LIVE_TESTS=1 to enable live SSH tests" edge
fi

echo -e "\n${BLUE}Generating test report...${NC}"
generate_report

echo -e "\n${BLUE}======================================${NC}"
echo -e "${BLUE}           TEST SUMMARY${NC}"
echo -e "${BLUE}======================================${NC}"
echo "Total Tests: ${TOTAL_TESTS}"
echo -e "${GREEN}Passed: ${PASSED_TESTS}${NC}"
echo -e "${RED}Failed: ${FAILED_TESTS}${NC}"
echo "Skipped: ${SKIPPED_TESTS}"
echo "Pass Rate: $(percent "$PASSED_TESTS" "$TOTAL_TESTS")%"
echo -e "\n${BLUE}Report saved to:${NC} $TEST_REPORT\n"

if [[ $FAILED_TESTS -eq 0 ]]; then
    echo -e "${GREEN}ALL EXECUTED TESTS PASSED${NC}\n"
    exit 0
fi

echo -e "${RED}SOME TESTS FAILED${NC}\n"
exit 1
