#!/bin/bash
# Multi-config, conversion, and installer regression; no real network or inventory.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
export SSHM_CONFIG_DIR="$TEST_DIR/configs" CALL_LOG="$TEST_DIR/calls" MOCK_EXIT=0
unset SSHM_CONFIG
mkdir -p "$SSHM_CONFIG_DIR" "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/mock" <<'SH'
#!/bin/bash
printf '%s\n' "$@" >> "$CALL_LOG"
case "${0##*/}" in
    sshpass) shift 2; exec "$@" ;;
    ssh) printf '0 0 0 0\n' ;;
esac
exit "$MOCK_EXIT"
SH
chmod +x "$TEST_DIR/bin/mock"
for tool in ssh scp sshpass fping ping; do ln -s mock "$TEST_DIR/bin/$tool"; done
export PATH="$TEST_DIR/bin:$PATH"
printf 'upload\n' > "$TEST_DIR/file"
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
    : > "$CALL_LOG"
    timeout 15 "$@" > "$TEST_DIR/out" 2> "$TEST_DIR/err" || code=$?
    check "exit $expected, got $code: $*" test "$code" -eq "$expected"
    if [[ "$code" != "$expected" ]]; then cat "$TEST_DIR/err" >&2; fi
}
make_group() {
    jq --argjson number "$2" --arg ip "$3" '.group_number=$number | .nodes[0].ip=$ip' \
        "$SCRIPT_DIR/shared/cli-test-inventory.json" > "$SSHM_CONFIG_DIR/ssh_remote_$1.json"
}
cli=(bash "$SCRIPT_DIR/sshm")
convert=(bash "$SCRIPT_DIR/convert_legacy_config.sh")
make_group default 0 192.0.2.10
make_group tw 1 192.0.2.11
make_group us 2 192.0.2.12
run 0 "${cli[@]}" -g
check 'catalog names' grep -q ssh_remote_tw.json "$TEST_DIR/out"
check 'catalog never connects' test ! -s "$CALL_LOG"
run 0 "${cli[@]}" -al
check 'all groups listed' grep -q 192.0.2.12 "$TEST_DIR/out"
check 'all groups never connects' test ! -s "$CALL_LOG"
for group in default 0 00; do
    run 0 "${cli[@]}" -g "$group" -c uptime 1
    check 'default target' grep -Fxq test@192.0.2.10 "$CALL_LOG"
done
for group in tw 1 01; do
    run 0 "${cli[@]}" -g "$group" -c uptime 1
    check 'selected target' grep -Fxq test@192.0.2.11 "$CALL_LOG"
done
run 0 "${cli[@]}" -c uptime 1 -g us
check 'trailing group flag' grep -Fxq test@192.0.2.12 "$CALL_LOG"
run 0 "${cli[@]}" -g tw -p -P 2299 -c uptime 1
check 'port override' grep -Fxq 2299 "$CALL_LOG"
run 0 "${cli[@]}" -g tw -s "$TEST_DIR/file" remote:/tmp/ 1
check 'upload group' grep -Fxq test@192.0.2.11:/tmp/ "$CALL_LOG"
run 0 "${cli[@]}" -s remote:/tmp/file "$TEST_DIR/download" -g us 1
check 'download group' grep -Fxq test@192.0.2.12:/tmp/file "$CALL_LOG"
run 42 env MOCK_EXIT=42 "${cli[@]}" -g tw -c 'exit 42' 1
run 42 env MOCK_EXIT=42 "${cli[@]}" -g tw -s "$TEST_DIR/file" remote:/tmp/ 1
run 0 "${cli[@]}" -g tw server host1
check 'host selection unchanged' grep -Fxq host@192.0.2.3 "$CALL_LOG"
run 0 "${cli[@]}" -g us server smc
check 'SMC selection unchanged' grep -Fxq root@192.0.2.4 "$CALL_LOG"

export SSHM_CONFIG="$SSHM_CONFIG_DIR/ssh_remote_us.json"
run 0 "${cli[@]}" -c uptime 1
check 'file override' grep -Fxq test@192.0.2.12 "$CALL_LOG"
run 0 "${cli[@]}" -g tw -c uptime 1
check 'group overrides file' grep -Fxq test@192.0.2.11 "$CALL_LOG"
unset SSHM_CONFIG
make_group duplicate 1 192.0.2.13
run 1 "${cli[@]}" -g 1 -c uptime 1
check 'ambiguous number never connects' test ! -s "$CALL_LOG"
for group in tw duplicate us default 2 0; do
    run 0 "${cli[@]}" -g "$group" -l
    check 'duplicate warning on stderr' grep -q 'Duplicate group number 1' "$TEST_DIR/err"
done
run 0 "${cli[@]}" -l
check 'default remains available' grep -q 192.0.2.10 "$TEST_DIR/out"
run 0 "${cli[@]}" -g
check 'duplicate catalog status' grep -q DUPLICATE "$TEST_DIR/out"
printf 'broken JSON\n' > "$SSHM_CONFIG_DIR/ssh_remote_bad.json"
printf '{"group_number":0,"nodes":[]}\n' > "$SSHM_CONFIG_DIR/ssh_remote_reserved.json"
run 0 "${cli[@]}" -g 2 -l
run 0 "${cli[@]}" -g 0 -l
run 0 "${cli[@]}" -al
check 'invalid group marked' grep -q 'INVALID (skipped)' "$TEST_DIR/out"
for group in bad reserved missing ../tw 90071992547409999999; do
    run 1 "${cli[@]}" -g "$group" -c uptime 1
    check 'invalid selection never connects' test ! -s "$CALL_LOG"
done
run 1 "${cli[@]}" -g -c uptime 1
run 1 "${cli[@]}" -g tw -g us -l
run 1 "${cli[@]}" -al -g tw
run 1 "${cli[@]}" -al -c uptime 1
run 1 "${cli[@]}" -g tw

# Conversion preserves the exact node values and cannot overwrite any path.
jq '.nodes' "$SCRIPT_DIR/shared/cli-test-inventory.json" > "$TEST_DIR/legacy.json"
cp "$TEST_DIR/legacy.json" "$TEST_DIR/original.json"
export SSHM_CONFIG_DIR="$TEST_DIR/converted"
run 0 "${convert[@]}" "$TEST_DIR/legacy.json" 0
check 'default metadata and node preservation' jq -e --slurpfile old "$TEST_DIR/legacy.json" \
    '.group_number == 0 and .nodes == $old[0]' "$SSHM_CONFIG_DIR/ssh_remote_default.json" > /dev/null
check 'private output permissions' test "$(stat -c %a "$SSHM_CONFIG_DIR/ssh_remote_default.json")" = 600
check 'source unchanged' cmp "$TEST_DIR/legacy.json" "$TEST_DIR/original.json"
run 0 "${convert[@]}" "$TEST_DIR/legacy.json" 1 tw
run 0 "${convert[@]}" "$TEST_DIR/legacy.json" 1 us
check 'converter duplicate warning' grep -q 'Duplicate group number 1' "$TEST_DIR/err"
run 1 "${convert[@]}" "$TEST_DIR/legacy.json" 0
run 1 "${convert[@]}" "$TEST_DIR/legacy.json" 0 default
run 1 "${convert[@]}" "$TEST_DIR/legacy.json" 2
run 1 "${convert[@]}" "$TEST_DIR/legacy.json" -1 tw
run 1 "${convert[@]}" "$TEST_DIR/legacy.json" 1.5 tw
run 1 "${convert[@]}" "$TEST_DIR/legacy.json" 9007199254740992 other
for name in default 12 ../escape 'a b'; do run 1 "${convert[@]}" "$TEST_DIR/legacy.json" 3 "$name"; done
run 1 "${convert[@]}" "$SSHM_CONFIG_DIR/ssh_remote_default.json" 3 new
printf '{}\n' > "$TEST_DIR/invalid.json"
run 1 "${convert[@]}" "$TEST_DIR/invalid.json" 3 new
check 'no partial output' test ! -e "$SSHM_CONFIG_DIR/ssh_remote_new.json"
ln -s "$TEST_DIR/original.json" "$SSHM_CONFIG_DIR/ssh_remote_link.json"
run 1 "${convert[@]}" "$TEST_DIR/legacy.json" 3 link
check 'symlink target unchanged' cmp "$TEST_DIR/original.json" "$TEST_DIR/legacy.json"
# A directory created after the existence check must not receive the temp file.
export REAL_LN="$(command -v ln)"
cat > "$TEST_DIR/bin/ln" <<'SH'
#!/bin/bash
mkdir -- "${@: -1}"
exec "$REAL_LN" "$@"
SH
chmod +x "$TEST_DIR/bin/ln"
run 1 "${convert[@]}" "$TEST_DIR/legacy.json" 3 race
check 'concurrent directory remains empty' test -z "$(ls -A "$SSHM_CONFIG_DIR/ssh_remote_race.json")"
rm "$TEST_DIR/bin/ln"
run 1 env SSHM_CONFIG="$TEST_DIR/legacy.json" "${cli[@]}" -l
check 'legacy conversion guidance' grep -q convert_legacy_config.sh "$TEST_DIR/err"

# Re-running the installer keeps an existing config and avoids package operations.
printf '#!/bin/sh\nexit 0\n' > "$TEST_DIR/bin/apt-get"
printf '#!/bin/sh\nexec "$@"\n' > "$TEST_DIR/bin/sudo"
chmod +x "$TEST_DIR/bin/apt-get" "$TEST_DIR/bin/sudo"
cp "$SSHM_CONFIG_DIR/ssh_remote_default.json" "$TEST_DIR/before-install.json"
mkdir -p "$TEST_DIR/prefix"
run 0 env PREFIX="$TEST_DIR/prefix" bash "$SCRIPT_DIR/install.sh"
check 'installer preserved inventory' cmp "$TEST_DIR/before-install.json" "$SSHM_CONFIG_DIR/ssh_remote_default.json"
check 'installer copied CLI' cmp "$SCRIPT_DIR/sshm" "$TEST_DIR/prefix/bin/sshm"

printf '%s checks, %s failures\n' "$checks" "$failures"
[[ "$failures" -eq 0 ]]
