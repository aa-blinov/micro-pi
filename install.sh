#!/bin/bash
# cast installer (macOS/Linux).
#
#   curl -fsSL https://aa-blinov.github.io/cast/install | bash
#
# (published from this file — see .github/workflows/pages.yml. `| bash`, not
# `| sh`: this script uses `set -o pipefail`, a bash/ksh extension that
# dash — /bin/sh on Debian/Ubuntu — rejects outright. Piping to an explicit
# interpreter ignores the #!/bin/bash shebang above, so the pipe itself has
# to name the right one.)
#
# Downloads the latest (or CAST_VERSION-pinned) release tarball, unpacks
# it to ~/.cast/install, and symlinks bin/cast onto PATH. The
# release is a pure JS bundle (see scripts/build.mjs) — architecture-
# independent, so there's no per-arch asset to pick, only Node.js itself is
# required on the machine already.
set -euo pipefail

REPO="${CAST_REPO:-aa-blinov/cast}"
API_BASE="${CAST_API_BASE:-https://api.github.com}"
DOWNLOAD_BASE_OVERRIDE="${CAST_DOWNLOAD_BASE:-}"
INSTALL_DIR="${CAST_INSTALL_DIR:-$HOME/.cast/install}"
BIN_DIR="${CAST_BIN_DIR:-$HOME/.local/bin}"
MIN_NODE_MAJOR=18

info() { printf '\033[36m%s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
err() { printf '\033[31m%s\033[0m\n' "$1" >&2; }

if ! command -v node >/dev/null 2>&1; then
	err "Node.js not found. cast's release bundle still needs Node.js ${MIN_NODE_MAJOR}+ installed — get it from https://nodejs.org or your package manager, then re-run this installer."
	exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
	err "Node.js ${MIN_NODE_MAJOR}+ required, found $(node -v). Upgrade Node.js and re-run this installer."
	exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
	err "curl is required but wasn't found."
	exit 1
fi

if [ -n "${CAST_VERSION:-}" ]; then
	TAG="v${CAST_VERSION#v}"
	info "Installing cast ${TAG} (pinned via CAST_VERSION)..."
	if [ -n "$DOWNLOAD_BASE_OVERRIDE" ]; then
		ASSET_URL="${DOWNLOAD_BASE_OVERRIDE%/}/cast-${TAG#v}.tar.gz"
	else
		ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/cast-${TAG#v}.tar.gz"
	fi
else
	info "Looking up the latest cast release..."
	RELEASE_JSON="$(curl -fsSL "${API_BASE}/repos/${REPO}/releases/latest")"
	# Avoids a jq dependency — GitHub's release JSON is predictable enough
	# for a plain grep/sed extraction, same approach most curl|sh installers
	# use to stay dependency-free.
	ASSET_URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*\.tar\.gz"' | head -n1 | sed -E 's/.*"(https?:[^"]+)"/\1/')"
	TAG="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
	if [ -n "$DOWNLOAD_BASE_OVERRIDE" ]; then
		ASSET_URL="${DOWNLOAD_BASE_OVERRIDE%/}/cast-${TAG#v}.tar.gz"
	fi
	if [ -z "$ASSET_URL" ]; then
		err "Couldn't find a release asset. Is https://github.com/${REPO}/releases populated yet?"
		exit 1
	fi
	info "Latest release: ${TAG}"
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

info "Downloading ${ASSET_URL}..."
curl -fsSL "$ASSET_URL" -o "$WORK_DIR/cast.tar.gz"

info "Installing to ${INSTALL_DIR}..."
rm -rf "$INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"
tar -xzf "$WORK_DIR/cast.tar.gz" -C "$WORK_DIR"
mv "$WORK_DIR/cast" "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/bin/cast"

mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/cast" "$BIN_DIR/cast"

INSTALLED_VERSION="$(node -e "console.log(require('$INSTALL_DIR/package.json').version)" 2>/dev/null || echo "unknown")"
info "cast ${INSTALLED_VERSION} installed."

case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*)
	warn "${BIN_DIR} isn't on your PATH yet. Add this to your shell profile (~/.zshrc, ~/.bashrc, ...):"
	warn "  export PATH=\"${BIN_DIR}:\$PATH\""
	;;
esac

info "Run 'cast' to get started."
