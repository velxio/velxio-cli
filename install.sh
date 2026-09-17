#!/bin/sh
# Installs velxio-cli into ~/.velxio/bin from the GitHub release assets.
#
#   curl -fsSL https://velxio.dev/ci/install.sh | sh
#   VELXIO_CLI_VERSION=v0.1.0 sh install.sh      # pin a version
#
# Detects the OS and CPU, downloads the bare binary for it, checks it against
# the release's SHA256SUMS and prints PATH advice. The release also carries
# zips of the same binaries; this script does not use them, because a slim CI
# image usually has curl and no unzip.
set -eu

REPO="velxio/velxio-cli"
BIN_DIR="${VELXIO_CLI_BIN_DIR:-$HOME/.velxio/bin}"
VERSION="${VELXIO_CLI_VERSION:-}"

say() { printf '%s\n' "$*" >&2; }
die() { say "install.sh: $*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "needs $1"; }
need uname

fetch() {
  # fetch <url> <out>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$1" -O "$2"
  else
    die "needs curl or wget"
  fi
}

case "$(uname -s)" in
  Linux)  OS="Linux" ;;
  Darwin) OS="macOS" ;;
  MINGW*|MSYS*|CYGWIN*) die "on Windows use install.ps1" ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  ARCH="64bit" ;;
  arm64|aarch64) ARCH="ARM64" ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac

if [ -z "$VERSION" ]; then
  # The latest release redirects to /releases/tag/<tag>.
  need curl
  VERSION=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed 's#.*/tag/##')
  [ -n "$VERSION" ] || die "cannot resolve the latest release"
fi
case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac

ASSET="velxio-cli_${VERSION}_${OS}_${ARCH}"
BASE="https://github.com/$REPO/releases/download/$VERSION"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say "downloading $ASSET"
fetch "$BASE/$ASSET" "$TMP/$ASSET"
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS"

EXPECTED=$(grep " $ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}')
[ -n "$EXPECTED" ] || die "$ASSET is not listed in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TMP/$ASSET" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
else
  die "needs sha256sum or shasum"
fi
[ "$EXPECTED" = "$ACTUAL" ] || die "SHA256 mismatch for $ASSET (expected $EXPECTED, got $ACTUAL)"

mkdir -p "$BIN_DIR"
install -m 0755 "$TMP/$ASSET" "$BIN_DIR/velxio-cli"

say "installed $("$BIN_DIR/velxio-cli" version) to $BIN_DIR/velxio-cli"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say ""
    say "add it to your PATH:"
    say "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
