#!/bin/bash
# Convert a legacy node array without modifying the source or replacing a file.
set -euo pipefail
umask 077

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
[[ $# -eq 2 || $# -eq 3 ]] || die 'Usage: convert_legacy_config.sh <legacy.json> <group_number> [group_name]'
source_file=$1
number=$2
[[ "$number" =~ ^[0-9]+$ ]] || die 'Group number must be a nonnegative integer.'
number=$(sed 's/^0*//' <<< "$number")
number=${number:-0}
[[ ${#number} -le 16 ]] && (( 10#$number <= 9007199254740991 )) || die 'Group number exceeds the supported integer range.'
if [[ "$number" == 0 ]]; then
    [[ $# -eq 2 ]] || die 'Group 0 is default and takes no group name.'
    group=default
else
    [[ $# -eq 3 ]] || die 'A nonzero group number requires a group name.'
    group=$3
    [[ "$group" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ && ! "$group" =~ ^[0-9]+$ && "$group" != default ]] || die 'Invalid or reserved group name.'
fi
[[ -f "$source_file" && -r "$source_file" ]] || die 'Input file is missing or unreadable.'
config_dir="${SSHM_CONFIG_DIR:-$HOME/sshm_config}"
destination="$config_dir/ssh_remote_$group.json"
[[ ! -e "$destination" && ! -L "$destination" ]] || die "Destination already exists: $destination"
mkdir -p "$config_dir"
temporary=$(mktemp "$config_dir/.sshm_convert.XXXXXX")
trap 'rm -f "$temporary"' EXIT
if ! jq -es --argjson number "$number" '
    if length == 1 and (.[0] | type == "array" and all(.[]; type == "object"))
    then {group_number:$number,nodes:.[0]} else error("legacy array required") end
' -- "$source_file" > "$temporary" 2>/dev/null; then
    die 'Input must contain one legacy JSON array of node objects; new-format files cannot be converted again.'
fi
# Linking publishes the complete file atomically and refuses an existing path.
ln -T -- "$temporary" "$destination" || die "Cannot create destination: $destination"
for file in "$config_dir"/ssh_remote_*.json; do
    [[ "$file" != "$destination" ]] || continue
    if jq -e --argjson number "$number" '.group_number == $number' -- "$file" >/dev/null 2>&1; then
        printf 'Warning: Duplicate group number %s: %s and %s. Select by name.\n' "$number" "$file" "$destination" >&2
    fi
done
printf '%s\n' "$destination"
