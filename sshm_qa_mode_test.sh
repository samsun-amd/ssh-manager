#!/bin/bash
# Offline regression for live -qa orchestration; never connects to a real target.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/bin" "$TEST_DIR/configs" "$TEST_DIR/tmp"
export SSHM_CONFIG_DIR="$TEST_DIR/configs" QA_CALLS="$TEST_DIR/calls"
export TMPDIR="$TEST_DIR/tmp" SSHM_QA_TIMEOUT=1 QA_MOCK_MODE=pass
unset SSHM_CONFIG SSHM_QA_PROBE
cat > "$TEST_DIR/bin/sshpass" <<'SH'
#!/bin/bash
shift 2
exec "$@"
SH
cat > "$TEST_DIR/bin/ssh" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "$QA_CALLS"
case "$QA_MOCK_MODE" in
    auth) echo 'Permission denied (publickey,password).' >&2; exit 255 ;;
    refused) echo 'Connection refused' >&2; exit 255 ;;
    connect) echo 'No route to host' >&2; exit 255 ;;
    timeout) exec sleep 30 ;;
    unsupported) echo 'ERROR: Invalid command specified.'; exit 0 ;;
    missing) exit 0 ;;
    exit42) exit 42 ;;
    banner) echo 'Previous authentication failed.' ;;
    mixed)
        if [[ "$*" == *test@192.0.2.1* ]]; then
            echo 'Permission denied (publickey,password).' >&2; exit 255
        fi ;;
esac
printf 'SSHM_QA_OK\n'
SH
chmod +x "$TEST_DIR/bin/ssh" "$TEST_DIR/bin/sshpass"
export PATH="$TEST_DIR/bin:$PATH"
checks=0 failures=0
check() {
    local label=$1
    shift
    checks=$((checks + 1))
    if ! "$@"; then printf 'FAIL: %s\n' "$label" >&2; failures=$((failures + 1)); fi
}
run() {
    local expected=$1 code=0
    shift
    : > "$QA_CALLS"
    timeout -k 2 20 bash "$SCRIPT_DIR/sshm" "$@" > "$TEST_DIR/out" 2> "$TEST_DIR/err" || code=$?
    check "exit $expected, got $code: $*" test "$expected" -eq "$code"
    if [[ "$expected" != "$code" ]]; then cat "$TEST_DIR/out" "$TEST_DIR/err" >&2; fi
}
for pair in default:0 tw:1 us:2; do
    jq --argjson number "${pair#*:}" '.group_number=$number' "$SCRIPT_DIR/shared/cli-test-inventory.json" \
        > "$SSHM_CONFIG_DIR/ssh_remote_${pair%:*}.json"
done
run 0 -qa
check 'all groups and all sub-targets' grep -q 'total=12 passed=12 failed=0' "$TEST_DIR/out"
check 'host uses noninteractive key auth' grep -q 'BatchMode=yes.*host@192.0.2.3' "$QA_CALLS"
check 'SMC retains the BMC jump' grep -q 'ProxyCommand=.*gateway@192.0.2.2.*root@192.0.2.4' "$QA_CALLS"
check 'private credentials not printed' test -z "$(grep -E 'client secret|jump secret|smc secret' "$TEST_DIR/out" "$TEST_DIR/err" || true)"
for group in default 0 tw 1 us 2; do
    run 0 -g "$group" -qa
    check 'selected group only' grep -q 'total=4 passed=4 failed=0' "$TEST_DIR/out"
done
export SSHM_CONFIG="$TEST_DIR/missing.json"
run 0 -qa
check 'no group ignores SSHM_CONFIG' grep -q 'total=12' "$TEST_DIR/out"
unset SSHM_CONFIG
cp "$SSHM_CONFIG_DIR/ssh_remote_tw.json" "$SSHM_CONFIG_DIR/ssh_remote_duplicate.json"
run 1 -qa -g 1
check 'ambiguous group never connects' test ! -s "$QA_CALLS"
run 0 -qa -g tw
check 'duplicate warning' grep -q 'Duplicate group number 1' "$TEST_DIR/err"
run 0 -qa
check 'all mode checks duplicate by name' grep -q 'total=16 passed=16' "$TEST_DIR/out"
printf 'invalid JSON\n' > "$SSHM_CONFIG_DIR/ssh_remote_bad.json"
run 1 -qa
check 'bad neighbor does not abort scan' grep -q 'total=17 passed=16 failed=1' "$TEST_DIR/out"
run 0 -qa -g 2
for args in '-qa -g' '-qa -g missing' '-qa -l' '-qa -al' '-qa -c uptime' '-qa -s a b' '-qa 1' '-qa -p' '-qa -P 22'; do
    read -r -a flags <<< "$args"
    run 1 "${flags[@]}"
    check 'invalid arguments never connect' test ! -s "$QA_CALLS"
done
# One client isolates status classification and timeout behavior.
jq '.nodes=[.nodes[0]]' "$SCRIPT_DIR/shared/cli-test-inventory.json" > "$SSHM_CONFIG_DIR/ssh_remote_default.json"
export QA_MOCK_MODE=banner
run 0 -qa -g 0
check 'verified success takes precedence over banner text' grep -q 'total=1 passed=1 failed=0' "$TEST_DIR/out"
for pair in auth:AUTH_FAILED refused:CONNECTION_REFUSED connect:CONNECT_FAILED timeout:TIMEOUT unsupported:COMMAND_UNSUPPORTED missing:COMMAND_FAILED exit42:COMMAND_FAILED; do
    export QA_MOCK_MODE=${pair%:*}
    run 1 -qa -g 0
    check "status ${pair#*:}" grep -q "${pair#*:}" "$TEST_DIR/out"
done
export QA_MOCK_MODE=mixed
run 1 -qa -g tw
check 'failure does not skip later nodes' grep -q 'total=4 passed=3 failed=1' "$TEST_DIR/out"
export QA_MOCK_MODE=pass
jq '.nodes[0].user=""' "$SSHM_CONFIG_DIR/ssh_remote_default.json" > "$TEST_DIR/invalid.json"
mv "$TEST_DIR/invalid.json" "$SSHM_CONFIG_DIR/ssh_remote_default.json"
run 1 -qa -g 0
check 'invalid node fields reported' grep -q CONFIG_ERROR "$TEST_DIR/out"
check 'invalid node never connects' test ! -s "$QA_CALLS"
printf '{"group_number":0,"nodes":[]}\n' > "$SSHM_CONFIG_DIR/ssh_remote_default.json"
run 1 -qa -g 0
check 'empty config reported' grep -q 'Config contains no targets' "$TEST_DIR/out"
jq '.nodes=[.nodes[] | select(.type=="smc")]' "$SCRIPT_DIR/shared/cli-test-inventory.json" > "$SSHM_CONFIG_DIR/ssh_remote_default.json"
run 1 -qa -g 0
check 'orphan SMC reported' grep -q 'SMC requires a server' "$TEST_DIR/out"
check 'orphan SMC never connects directly' test ! -s "$QA_CALLS"
jq '.nodes[1].hosts="invalid"' "$SCRIPT_DIR/shared/cli-test-inventory.json" > "$SSHM_CONFIG_DIR/ssh_remote_default.json"
run 1 -qa -g 0
check 'bad hosts do not suppress other probes' grep -q 'total=4 passed=3 failed=1' "$TEST_DIR/out"
printf '{"group_number":0,"nodes":[{"type":"unknown"}]}\n' > "$SSHM_CONFIG_DIR/ssh_remote_default.json"
run 1 -qa -g 0
check 'unsupported node type reported' grep -q CONFIG_ERROR "$TEST_DIR/out"
check 'unsupported node never connects' test ! -s "$QA_CALLS"
jq 'del(.nodes[1].bmc.pass)' "$SCRIPT_DIR/shared/cli-test-inventory.json" > "$SSHM_CONFIG_DIR/ssh_remote_default.json"
run 0 -qa -g 0
check 'key-only BMC jump is noninteractive' grep -q 'ProxyCommand=.*BatchMode=yes.*gateway@192.0.2.2' "$QA_CALLS"
original_config_dir=$SSHM_CONFIG_DIR
export SSHM_CONFIG_DIR="$TEST_DIR/empty-configs"
mkdir "$SSHM_CONFIG_DIR"
run 1 -qa
check 'empty config directory reported' grep -q 'No configs found' "$TEST_DIR/err"
export SSHM_CONFIG_DIR=$original_config_dir
for seconds in 0 -1 abc 301; do
    export SSHM_QA_TIMEOUT=$seconds
    run 1 -qa -g tw
    check 'invalid timeout never connects' test ! -s "$QA_CALLS"
done
check 'temporary probe files cleaned' test -z "$(ls -A "$TMPDIR")"
printf '%s checks, %s failures\n' "$checks" "$failures"
[[ "$failures" -eq 0 ]]
