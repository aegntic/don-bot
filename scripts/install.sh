#!/usr/bin/env sh
set -eu

REPO="aegntic/don-bot"
RELEASES_API="https://api.github.com/repos/${REPO}/releases"
DOWNLOAD_BASE="https://github.com/${REPO}/releases/download"

log() {
  printf '%s\n' "$*"
}

err() {
  printf 'error: %s\n' "$*" >&2
}

cargo_fallback() {
  err "You can build don-guard from source instead:"
  err "  git clone https://github.com/${REPO}.git"
  err "  cargo build --release --manifest-path don-bot/crates/don-guard/Cargo.toml"
  err "  mkdir -p \"\${DON_INSTALL_DIR:-\$HOME/.don/bin}\""
  err "  cp don-bot/crates/don-guard/target/release/don-guard \"\${DON_INSTALL_DIR:-\$HOME/.don/bin}/don-guard\""
}

detect_platform() {
  raw_os="$(uname -s)"
  raw_arch="$(uname -m)"

  case "$raw_os" in
    Linux)
      OS="linux"
      ;;
    Darwin)
      OS="macos"
      ;;
    *)
      err "Unsupported operating system: ${raw_os}"
      cargo_fallback
      exit 1
      ;;
  esac

  case "$raw_arch" in
    x86_64 | amd64)
      ARCH="x86_64"
      ;;
    aarch64 | arm64)
      ARCH="aarch64"
      ;;
    *)
      err "Unsupported architecture: ${raw_arch}"
      cargo_fallback
      exit 1
      ;;
  esac

  if [ "$OS" = "linux" ] && [ "$ARCH" = "aarch64" ]; then
    err "Prebuilt don-guard binaries are not published for linux-aarch64."
    cargo_fallback
    exit 1
  fi

  ASSET="don-guard-${OS}-${ARCH}"
}

fetch_text() {
  url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -H "Accept: application/vnd.github+json" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --header="Accept: application/vnd.github+json" "$url"
  else
    err "Neither curl nor wget is installed."
    exit 1
  fi
}

download_file() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    err "Neither curl nor wget is installed."
    exit 1
  fi
}

resolve_tag() {
  if [ -n "${DON_VERSION:-}" ]; then
    TAG="$DON_VERSION"
    return 0
  fi

  releases_json="$(fetch_text "$RELEASES_API")" || {
    err "Failed to query GitHub releases from ${RELEASES_API}"
    exit 1
  }

  if command -v python3 >/dev/null 2>&1; then
    TAG="$(printf '%s' "$releases_json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for rel in data if isinstance(data, list) else []:
    if isinstance(rel, dict) and not rel.get("draft", False) and rel.get("tag_name"):
        print(rel["tag_name"])
        break
')"
  elif command -v bun >/dev/null 2>&1; then
    TAG="$(printf '%s' "$releases_json" | bun -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const rel = Array.isArray(data) ? data.find((r) => r && !r.draft && r.tag_name) : null;
if (rel && rel.tag_name) console.log(rel.tag_name);
')"
  else
    TAG="$(printf '%s' "$releases_json" | tr '\r\n' '  ' | sed 's/,[[:space:]]*"/,\n"/g; s/{[[:space:]]*"/{\n"/g' | awk '
      /"tag_name"[[:space:]]*:/ {
        t = $0
        sub(/.*"tag_name"[[:space:]]*:[[:space:]]*"/, "", t)
        sub(/".*/, "", t)
        tag = t
      }
      /"draft"[[:space:]]*:[[:space:]]*false/ {
        if (tag != "") {
          print tag
          exit 0
        }
      }
      /"draft"[[:space:]]*:[[:space:]]*true/ {
        tag = ""
      }
    ')"
  fi

  if [ -z "${TAG:-}" ]; then
    err "Could not determine a non-draft release tag from ${RELEASES_API}."
    err "Set DON_VERSION (e.g. DON_VERSION=v0.6.0) to install a specific tag."
    exit 1
  fi
}

compute_sha256() {
  file_path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file_path" | awk '{ print tolower($1) }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{ print tolower($1) }'
  else
    err "Neither sha256sum nor shasum is installed; refusing unverified binary."
    exit 1
  fi
}

verify_checksum() {
  binary_path="$1"
  sums_path="$2"

  expected_hash="$(awk -v file="$ASSET" '
    NF >= 2 {
      name = $2
      sub(/^\*/, "", name)
      if (name == file) {
        print tolower($1)
        exit 0
      }
    }
  ' "$sums_path")"

  case "$expected_hash" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      ;;
    *)
      err "Missing or malformed SHA-256 entry for ${ASSET} in SHA256SUMS.txt; aborting."
      exit 1
      ;;
  esac

  actual_hash="$(compute_sha256 "$binary_path")"
  if [ "$expected_hash" != "$actual_hash" ]; then
    err "SHA-256 verification failed for ${ASSET}!"
    err "  expected: ${expected_hash}"
    err "  actual:   ${actual_hash}"
    exit 1
  fi
}

main() {
  detect_platform
  resolve_tag

  install_dir="${DON_INSTALL_DIR:-${HOME}/.don/bin}"
  install_path="${install_dir}/don-guard"

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/don-install.XXXXXX")"
  cleanup() {
    rm -rf "${TMP_DIR:-}" "${STAGED_BIN:-}"
  }
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT
  trap 'cleanup; exit 143' TERM

  bin_url="${DOWNLOAD_BASE}/${TAG}/${ASSET}"
  sums_url="${DOWNLOAD_BASE}/${TAG}/SHA256SUMS.txt"
  tmp_bin="${TMP_DIR}/${ASSET}"
  tmp_sums="${TMP_DIR}/SHA256SUMS.txt"

  log "Downloading ${ASSET} (${TAG})..."
  download_file "$bin_url" "$tmp_bin"
  download_file "$sums_url" "$tmp_sums"

  log "Verifying SHA-256 checksum..."
  verify_checksum "$tmp_bin" "$tmp_sums"

  mkdir -p "$install_dir"
  STAGED_BIN="${install_dir}/.don-guard.tmp.$$"
  cp "$tmp_bin" "$STAGED_BIN"
  chmod 755 "$STAGED_BIN"
  mv -f "$STAGED_BIN" "$install_path"
  STAGED_BIN=""

  log "Running don-guard health probe..."
  health_out="$(printf '{"op":"health"}\n' | "$install_path")" || {
    err "Health probe failed for ${install_path}"
    exit 1
  }

  log ""
  log "Installed don-guard successfully:"
  log "  Version:  ${TAG}"
  log "  Asset:    ${ASSET}"
  log "  Path:     ${install_path}"
  log "  Health:   ${health_out}"
  case ":${PATH:-}:" in
    *":${install_dir}:"*) ;;
    *)
      log ""
      log "Note: Add ${install_dir} to your PATH:"
      log "  export PATH=\"${install_dir}:\$PATH\""
      ;;
  esac
}

main "$@"
