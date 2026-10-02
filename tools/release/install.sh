#!/bin/sh
set -eu
umask 077
# Publication substitutes this reviewed public key and exact release base URL.
PUBLIC_KEY='__ACE_RELEASE_PUBLIC_KEY__'
BASE='__ACE_RELEASE_BASE_URL__'
case "$BASE" in https://*) ;; *) echo 'Installer has not been configured for publication' >&2; exit 1;; esac
case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) echo 'Unsupported OS' >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64) arch=x64;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
target=$os-$arch
case "$target" in
  darwin-arm64) pinned='__ACE_DARWIN_ARM64_SHA256__';;
  darwin-x64) pinned='__ACE_DARWIN_X64_SHA256__';;
  linux-arm64) pinned='__ACE_LINUX_ARM64_SHA256__';;
  linux-x64) pinned='__ACE_LINUX_X64_SHA256__';;
esac
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ace-install.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
printf '%s\n' "$PUBLIC_KEY" > "$scratch/key.pem"
fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 120 --max-filesize 268435456 "$1" -o "$2"; }
fetch "$BASE/$target.json" "$scratch/manifest.json"
fetch "$BASE/$target.sig" "$scratch/signature.txt"
[ "$(wc -c < "$scratch/manifest.json")" -le 16384 ] || exit 1
[ "$(wc -c < "$scratch/signature.txt")" -le 128 ] || exit 1
# Publisher emits compact JSON in this exact form; restrictive fields forbid shell/path syntax.
archive=$(sed -n 's/.*"archive":"\(ace-[a-z0-9.-]*\.tar\.gz\)".*/\1/p' "$scratch/manifest.json")
sha=$(sed -n 's/.*"sha256":"\([a-f0-9]*\)".*/\1/p' "$scratch/manifest.json")
[ -n "$archive" ] && [ "${#sha}" -eq 64 ] || exit 1
fetch "$BASE/$archive" "$scratch/artifact.tar.gz"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$scratch/artifact.tar.gz" | cut -d ' ' -f 1); else actual=$(shasum -a 256 "$scratch/artifact.tar.gz" | cut -d ' ' -f 1); fi
[ "$actual" = "$sha" ] && [ "$actual" = "$pinned" ] || { echo 'Checksum mismatch' >&2; exit 1; }
mkdir "$scratch/artifact"
# The trusted installer pins this archive independently of the downloaded manifest.
tar -xzf "$scratch/artifact.tar.gz" -C "$scratch/artifact"
"$scratch/artifact/bin/node" -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const [manifest, signature, key, target, sha] = process.argv.slice(1);
const bytes = fs.readFileSync(manifest), sig = Buffer.from(fs.readFileSync(signature, "utf8").trim(), "base64");
if (sig.length !== 64 || !crypto.verify(null, bytes, crypto.createPublicKey(fs.readFileSync(key)), sig)) throw new Error("Release signature rejected");
const data = JSON.parse(bytes.toString());
if (data.target !== target || data.sha256 !== sha) throw new Error("Release target or checksum mismatch");
' "$scratch/manifest.json" "$scratch/signature.txt" "$scratch/key.pem" "$target" "$actual"
cp "$scratch/manifest.json" "$scratch/artifact/release.json"
"$scratch/artifact/bin/node" "$scratch/artifact/ace.mjs" install-artifact "$scratch/artifact"
printf 'Installed. Run %s/bin/ace status\n' "${ACE_HOME:-$HOME/.ace}"
