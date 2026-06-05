#!/bin/bash
#
# sshm installer
#
# Idempotent installer for the sshm SSH manager. Installs runtime
# dependencies, copies sshm to a bin directory on PATH, and seeds a private
# inventory file without overwriting an existing one.
#
# Usage:
#   ./install.sh                 Install using defaults
#   PREFIX=$HOME/.local ./install.sh   Install without sudo into a user prefix
#
# Environment:
#   PREFIX        Install prefix (default: /usr/local). Binary goes to $PREFIX/bin.
#   SSHM_CONFIG_DIR   Directory for the private inventory (default: $HOME/note).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PREFIX="${PREFIX:-/usr/local}"
BIN_DIR="$PREFIX/bin"
CONFIG_DIR="${SSHM_CONFIG_DIR:-$HOME/note}"
CONFIG_FILE="$CONFIG_DIR/ssh_remote.json"
EXAMPLE_CONFIG="$SCRIPT_DIR/ssh_remote.json"

# Runtime dependencies. tar/gzip are required for fast directory transfers,
# pv is optional but enables progress bars.
REQUIRED_PKGS=(jq openssh-client sshpass tar gzip)
OPTIONAL_PKGS=(fping pv)

RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}Warning:${NC} $*" >&2; }
err()  { echo -e "${RED}Error:${NC} $*" >&2; }

# Pick a privilege-escalation helper only when needed.
maybe_sudo() {
    if [[ "$(id -u)" -eq 0 ]]; then
        "$@"
    elif command -v sudo &> /dev/null; then
        sudo "$@"
    else
        err "Need root privileges for: $*"
        err "Re-run as root or install sudo, or set PREFIX to a writable location."
        exit 1
    fi
}

install_dependencies() {
    local pkgs=("${REQUIRED_PKGS[@]}" "${OPTIONAL_PKGS[@]}")

    if command -v apt-get &> /dev/null; then
        info "Installing dependencies via apt: ${pkgs[*]}"
        maybe_sudo apt-get update -y
        maybe_sudo apt-get install -y "${pkgs[@]}"
    elif command -v dnf &> /dev/null; then
        info "Installing dependencies via dnf"
        # Package names differ on RHEL-family; map the common ones.
        maybe_sudo dnf install -y jq openssh-clients sshpass tar gzip fping pv || \
            warn "Some packages may need manual installation on this distro."
    elif command -v pacman &> /dev/null; then
        info "Installing dependencies via pacman"
        maybe_sudo pacman -Sy --noconfirm jq openssh sshpass tar gzip fping pv || \
            warn "Some packages may need manual installation on this distro."
    else
        warn "No supported package manager found (apt/dnf/pacman)."
        warn "Please install these tools manually before using sshm:"
        warn "  required: ${REQUIRED_PKGS[*]}"
        warn "  optional: ${OPTIONAL_PKGS[*]} (fping for ping checks, pv for progress bars)"
    fi
}

install_binary() {
    if [[ ! -f "$SCRIPT_DIR/sshm" ]]; then
        err "sshm not found next to install.sh ($SCRIPT_DIR/sshm)."
        exit 1
    fi

    info "Installing sshm to $BIN_DIR/sshm"
    if [[ -w "$BIN_DIR" ]] || { [[ ! -e "$BIN_DIR" ]] && [[ -w "$PREFIX" ]]; }; then
        install -D -m 0755 "$SCRIPT_DIR/sshm" "$BIN_DIR/sshm"
    else
        maybe_sudo install -D -m 0755 "$SCRIPT_DIR/sshm" "$BIN_DIR/sshm"
    fi
}

setup_config() {
    if [[ -f "$CONFIG_FILE" ]]; then
        info "Existing inventory kept: $CONFIG_FILE"
        return
    fi

    if [[ ! -f "$EXAMPLE_CONFIG" ]]; then
        warn "No example inventory found at $EXAMPLE_CONFIG; skipping config setup."
        return
    fi

    info "Creating private inventory at $CONFIG_FILE"
    mkdir -p "$CONFIG_DIR"
    cp "$EXAMPLE_CONFIG" "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
    warn "Edit $CONFIG_FILE with your real inventory (credentials, IPs)."
}

verify() {
    if command -v sshm &> /dev/null; then
        info "sshm installed: $(command -v sshm)"
    else
        warn "sshm is installed to $BIN_DIR but that directory is not on your PATH."
        warn "Add it to PATH, e.g.: export PATH=\"$BIN_DIR:\$PATH\""
    fi
    echo
    info "Done. Try: sshm -l"
}

main() {
    install_dependencies
    install_binary
    setup_config
    verify
}

main "$@"
