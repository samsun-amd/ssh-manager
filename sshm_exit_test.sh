#!/bin/bash
# Offline CLI regression: exact transport arguments, exit codes, and real tar/gzip.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/bin"
export MOCK_LOG="$TEST_DIR/calls.jsonl" REAL_TAR=$(command -v tar) REAL_GZIP=$(command -v gzip)
export MOCK_MODE=status MOCK_SCP_EXIT=0 MOCK_SSH_EXIT=0 MOCK_NO_TAR=0 MOCK_FAIL=''
export SSHM_CONFIG_DIR="$TEST_DIR/configs"
export SSHM_CONFIG="$SCRIPT_DIR/shared/cli-test-inventory.json" SSHM_PROGRESS=off
export SSHM_FORCE_COMPRESS=0 SSHM_NO_COMPRESS=0 SSHM_TAR_THRESHOLD=10485760 SSHM_COMPRESSED_RATIO=70
unset SSHM_TEST_REMOTE

# Every transport is replaced; exec mode runs remote shell commands locally.
# Only the temporary fixture paths are used in commands executed by this mock.
cat > "$TEST_DIR/bin/mock" <<'SH'
#!/bin/bash
tool=${0##*/}
role=${SSHM_TEST_REMOTE:-local}
jq -cn --arg tool "$tool" --arg role "$role" --args \
    '{tool:$tool, role:$role, args:$ARGS.positional}' -- "$@" >> "$MOCK_LOG"
case "$tool" in
    sshpass) shift 2; exec "$@" ;;
    tar|gzip)
        if [[ "$tool" == tar ]]; then real=$REAL_TAR; else real=$REAL_GZIP; fi
        "$real" "$@"
        code=$?
        # Fail after producing/consuming data: the other pipeline end can succeed.
        [[ "$MOCK_FAIL" == "$role:$tool" ]] && exit 42
        exit "$code"
        ;;
    ssh|scp)
        if [[ "$MOCK_MODE" == status ]]; then
            if [[ "$tool" == scp ]]; then exit "$MOCK_SCP_EXIT"; fi
            printf '0 0 0 0\n'
            printf '%s' "${MOCK_REMOTE_OUTPUT:-}"
            exit "$MOCK_SSH_EXIT"
        fi
        while [[ $# -gt 0 ]]; do
            case "$1" in
                -o|-p|-P) shift 2 ;;
                -O|-r|-tt) shift ;;
                *) break ;;
            esac
        done
        if [[ "$tool" == scp ]]; then
            src=$1 dest=$2
            [[ "$src" == *@*:* ]] && src=${src#*:}
            [[ "$dest" == *@*:* ]] && dest=${dest#*:}
            exec cp -a -- "$src" "$dest"
        fi
        shift # user@host
        [[ $# -eq 1 ]] || exit 90
        if [[ "$MOCK_NO_TAR" == 1 && "$1" == *'command -v tar'* ]]; then
            if [[ "$1" == 'set -- '* ]]; then printf '0 1 0 0\n'; else printf '0\n'; fi
            exit 0
        fi
        export SSHM_TEST_REMOTE=remote
        exec bash -c "$1"
        ;;
esac
exit 91
SH
chmod +x "$TEST_DIR/bin/mock"
for tool in ssh scp sshpass tar gzip; do ln -s mock "$TEST_DIR/bin/$tool"; done
export PATH="$TEST_DIR/bin:$PATH"

checks=0 failures=0
check() {
    local label=$1
    shift
    checks=$((checks + 1))
    if ! "$@"; then
        printf 'FAIL: %s\n' "$label" >&2
        failures=$((failures + 1))
    fi
}
check_exit() {
    local expected=$1 actual=0
    shift
    : > "$MOCK_LOG"
    timeout 10 bash "$SCRIPT_DIR/sshm" "$@" > "$TEST_DIR/output" 2>&1 || actual=$?
    check "exit $expected, got $actual: $*" test "$actual" -eq "$expected"
    if [[ "$actual" -ne "$expected" ]]; then cat "$TEST_DIR/output" >&2; fi
}
check_call() {
    local tool=$1
    shift
    check "$tool arguments: $*" jq -se --arg tool "$tool" --args \
        'any(.[]; .tool == $tool and .args == $ARGS.positional)' -- "$@" < "$MOCK_LOG" > /dev/null
}
check_no_call() {
    check "no $1 call" jq -se --arg tool "$1" 'all(.[]; .tool != $tool)' "$MOCK_LOG" > /dev/null
}
check_tar_mode() {
    check "tar mode $1" jq -se --arg flag "$1" \
        'any(.[]; .tool == "tar" and (.args | index($flag)))' "$MOCK_LOG" > /dev/null
    check_no_call scp
}

printf 'file content\000\377\n' > "$TEST_DIR/file with space"
common=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR)
proxy='ProxyCommand=sshpass -p jump\ secret ssh -p 2202 -W %h:%p -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR gateway@192.0.2.2'
remote_command='printf "%s\n" "$HOME"; exit 42'

# Exact argument arrays catch wrong endpoints, ports, quoting, and unexpected jumps.
while IFS='|' read -r selector conn port password jump; do
    read -r -a target <<< "$selector"
    ssh_opts=("${common[@]}" -p "$port")
    scp_opts=("${common[@]}" -P "$port")
    if [[ "$jump" == yes ]]; then
        ssh_opts+=(-o "$proxy")
        scp_opts+=(-O -o "$proxy")
    fi
    for code in 0 42 255; do
        export MOCK_SCP_EXIT=$code MOCK_SSH_EXIT=0
        check_exit "$code" -s "$TEST_DIR/file with space" 'remote:/tmp/dest with space/' "${target[@]}"
        check_call scp "${scp_opts[@]}" "$TEST_DIR/file with space" "$conn:/tmp/dest with space/"
        if [[ -n "$password" ]]; then
            check_call sshpass -p "$password" scp "${scp_opts[@]}" "$TEST_DIR/file with space" "$conn:/tmp/dest with space/"
        else
            check_no_call sshpass
        fi
        check_exit "$code" -s 'remote:/tmp/file with space' "$TEST_DIR/download" "${target[@]}"
        check_call scp "${scp_opts[@]}" "$conn:/tmp/file with space" "$TEST_DIR/download"
    done
    export MOCK_SSH_EXIT=42
    check_exit 42 -c "$remote_command" "${target[@]}"
    check_call ssh "${ssh_opts[@]}" "$conn" "$remote_command"
done <<'CASES'
client|test@192.0.2.1|2201|client secret|no
1|test@192.0.2.1|2201|client secret|no
192.0.2.1|test@192.0.2.1|2201|client secret|no
server|gateway@192.0.2.2|2202|jump secret|no
server bmc|gateway@192.0.2.2|2202|jump secret|no
2 host1|host@192.0.2.3|2203||no
192.0.2.3|host@192.0.2.3|2203||no
server smc|root@192.0.2.4|2204|smc secret|yes
CASES

# A target port override must not change the BMC jump port.
export MOCK_SSH_EXIT=0 MOCK_SCP_EXIT=0
for flag in '-P 2299' '--port 2299' '--port=2299'; do
    read -r -a override <<< "$flag"
    check_exit 0 "${override[@]}" -c "$remote_command" server smc
    check_call ssh "${common[@]}" -p 2299 -o "$proxy" root@192.0.2.4 "$remote_command"
    check_exit 0 "${override[@]}" -s "$TEST_DIR/file with space" remote:/tmp/ server smc
    check_call scp "${common[@]}" -P 2299 -O -o "$proxy" "$TEST_DIR/file with space" root@192.0.2.4:/tmp/
done
export MOCK_SSH_EXIT=255
check_exit 255 -s remote:/tmp/file "$TEST_DIR/download" client
check_no_call scp
check_exit 255 client

# Exercise actual terminal detection through a PTY; all SSH is still mocked.
check_pty() {
    local command actual=0
    printf -v command '%q ' bash "$SCRIPT_DIR/sshm" "$@"
    timeout 10 env SHELL=/bin/bash TERM="${TEST_TERM:-xterm-256color}" \
        script -q -e -c "$command" /dev/null </dev/null > "$TEST_DIR/output" 2>&1 || actual=$?
    check "PTY exit $MOCK_SSH_EXIT, got $actual: $*" test "$actual" -eq "$MOCK_SSH_EXIT"
}
check_titles() {
    local actual
    actual=$(LC_ALL=C grep -ao $'\033]0;[^\007]*\007' "$TEST_DIR/output" || true)
    check 'exact terminal title sequence' test "$actual" = "$1"
}
export MOCK_SSH_EXIT=0 MOCK_SCP_EXIT=0 MOCK_REMOTE_OUTPUT=''
while IFS='|' read -r selector title; do
    read -r -a target <<< "$selector"
    check_pty "${target[@]}"
    check_titles $'\033]0;'"$title"$'\007'
done <<'CASES'
client|client
1|client
192.0.2.1|client
server|server
2 bmc|server
server host1|server
192.0.2.2|server
192.0.2.3|server
server smc|server
smc|smc
3|smc
192.0.2.4|smc
CASES
export MOCK_REMOTE_OUTPUT=$'\033]0;remote tmux\007' MOCK_SSH_EXIT=42
check_pty client
check_titles $'\033]0;client\007\n\033]0;remote tmux\007'
export MOCK_REMOTE_OUTPUT='' MOCK_SSH_EXIT=0
check_pty -c "$remote_command" client
check_titles ''
check_pty -s "$TEST_DIR/file with space" remote:/tmp/ client
check_titles ''
TEST_TERM=dumb check_pty client
check_titles ''
check_exit 0 client
check_titles ''

# Group selection and untrusted JSON names must preserve text, not controls.
mkdir -p "$SSHM_CONFIG_DIR"
jq '.group_number=1 | .nodes[0].name="Lab %s \\ path 台北\u0000\u0007\u001b\n\r\u007f\u009c"' \
    "$SSHM_CONFIG" > "$SSHM_CONFIG_DIR/ssh_remote_lab.json"
check_pty -g lab 1
check_titles $'\033]0;Lab %s \\ path 台北\007'
jq 'del(.nodes[0].name)' "$SSHM_CONFIG" > "$TEST_DIR/unnamed.json"
SSHM_CONFIG="$TEST_DIR/unnamed.json" check_pty 1
check_titles ''

# Execute the real command string without SSH to test shell quoting and tar bytes.
export MOCK_MODE=exec MOCK_SSH_EXIT=0
tree="$TEST_DIR/tree with 'quote' and \$dollar"
mkdir -p "$tree/sub/empty" "$TEST_DIR/remote"
cp "$TEST_DIR/file with space" "$tree/sub/binary file"
printf 'hidden\n' > "$tree/.hidden"
touch "$tree/empty file"
for compression in plain gzip; do
    if [[ "$compression" == gzip ]]; then
        export SSHM_FORCE_COMPRESS=1 SSHM_NO_COMPRESS=0
        create=-cz extract=-xz
    else
        export SSHM_FORCE_COMPRESS=0 SSHM_NO_COMPRESS=1
        create=-c extract=-x
    fi
    remote="$TEST_DIR/remote/$compression"
    download="$TEST_DIR/download-$compression"
    check_exit 0 -s "$tree" "remote:$remote" server smc
    check_tar_mode "$create"
    check "uploaded $compression tree contents" diff -r "$tree" "$remote/${tree##*/}"
    check_exit 0 -s "remote:$remote/${tree##*/}" "$download" server smc
    check_tar_mode "$extract"
    check "downloaded $compression tree contents" diff -r "$tree" "$download/${tree##*/}"

    # Exercise both pipeline ends; failures occur after real data has flowed.
    for role in local remote; do
        export MOCK_FAIL="$role:tar"
        check_exit 42 -s "$tree" "remote:$remote" client
        check_exit 42 -s "remote:$remote/${tree##*/}" "$download" client
    done
    export MOCK_FAIL=''
done

# GNU tar translates a gzip subprocess failure to exit 2.
for role in local remote; do
    export MOCK_FAIL="$role:gzip"
    check_exit 2 -s "$tree" "remote:$remote" client
    check_exit 2 -s "remote:$remote/${tree##*/}" "$download" client
done
export MOCK_FAIL='' MOCK_NO_TAR=1
mkdir -p "$TEST_DIR/fallback" "$TEST_DIR/fallback-download"
check_exit 0 -s "$tree" "remote:$TEST_DIR/fallback" client
check_call scp "${common[@]}" -P 2201 -r "$tree" "test@192.0.2.1:$TEST_DIR/fallback"
check "fallback upload contents" diff -r "$tree" "$TEST_DIR/fallback/${tree##*/}"
check_exit 0 -s "remote:$TEST_DIR/fallback/${tree##*/}" "$TEST_DIR/fallback-download" client
check_call scp "${common[@]}" -P 2201 -r "test@192.0.2.1:$TEST_DIR/fallback/${tree##*/}" "$TEST_DIR/fallback-download"
check "fallback download contents" diff -r "$tree" "$TEST_DIR/fallback-download/${tree##*/}"

printf '%s checks, %s failures\n' "$checks" "$failures"
[[ "$failures" -eq 0 ]]
