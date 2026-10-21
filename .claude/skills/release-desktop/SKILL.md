---
name: release-desktop
description: Build, sign and notarize the macOS desktop app on this Mac and put it in a GitHub release (draft first).
disable-model-invocation: true
argument-hint: "[publish]"
---

Release the desktop app from the owner's Mac to `arpan404/ace` on GitHub. The repo is public: a published release is visible to everyone at once, so every run ends on a **draft** unless the owner passed `publish` or says to publish in this conversation.

Secrets live in `~/.ace-release/`, outside the repo:

- `release.env`: `CSC_NAME`, `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `ACE_RELEASE_PUBLIC_KEY_FILE`.
- `ace-key.pem`: the Ed25519 release private key. Only its path is ever used.

Check variables by name and file existence only; secret values stay out of the transcript, commands and commits.

## 1. Preflight

Run from the main checkout (`~/Code/ace-next`). Every check passes before anything builds; on a failure, stop and tell the owner which check failed and how to fix it.

1. Branch is `main`, level with `origin/main` after `git fetch`, and `git status --short` shows no tracked changes.
2. `version` is the `version` in `apps/desktop/package.json`. `gh release view v<version> -R arpan404/ace` fails (the tag is free). If it exists, stop: bumping the version is the owner's call, done in a PR.
3. `~/.ace-release/release.env` loads (`set -a; source ~/.ace-release/release.env; set +a`), every variable above is non-empty with no `XXXX`/`xxxx` placeholder, and the `.p8` and public key files exist.
4. `security find-identity -v -p codesigning` lists `Developer ID Application: $CSC_NAME`.
5. `xcrun notarytool history --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"` exits 0.
6. `uname -m` is `arm64`. The build targets the host only, so this release is Apple silicon only.
7. Node 24.13.0 for the build: download `node-v24.13.0-darwin-arm64.tar.gz` from nodejs.org into a new temp directory and check it against the `darwin-arm64` hash in `tools/release/src/node-runtime.ts`. The daemon archives refuse any other Node.

## 2. Build

```sh
bun install --frozen-lockfile
set -a; source ~/.ace-release/release.env; set +a
export ACE_RELEASE_PRIVATE_KEY_FILE=~/.ace-release/ace-key.pem
PATH=<node 24.13.0>/bin:$PATH bun run release:doctor
PATH=<node 24.13.0>/bin:$PATH bun run release:build <version> --with-daemon
```

`release:doctor` lists every check; stop on any ✗. `release:build` packages, signs and notarizes the app, verifies it (`codesign`, `spctl`, `stapler`), builds and signs the daemon manifests for both macOS architectures, and stages everything with checksums under `dist/releases/v<version>`. It passes the version to the packager itself, so an `ACE_VERSION` inherited from a running ace does not leak in.

It takes 10–20 minutes (notarization is most of it); run it in the background and wait for it to exit. Done when it exits 0 and `dist/releases/v<version>/` holds `ace-<version>-arm64.dmg`, `ace-<version>-arm64-mac.zip`, their blockmaps, `latest-mac.yml`, `darwin-arm64.json`/`.sig`, `darwin-x64.json`/`.sig` and both daemon archives.

## 3. Notes

Write `dist/releases/v<version>/notes.md`. The app shows these notes when it offers the update, so write them for users, in Markdown: a platform and install line, then `## New`, `## Improved` and `## Fixed`, covering the user-facing changes since the previous tag (merged PR titles from `git log --merges <previous-tag>..HEAD`). Leave out internal changes such as version bumps.

## 4. Draft release

```sh
bun run release:publish <version> --draft --notes-file dist/releases/v<version>/notes.md
```

It refuses files that changed since the build or a commit GitHub doesn't have, and uploads to a draft tagged at the built commit. Done when `gh release view v<version> -R arpan404/ace` shows `draft: true` with every staged file.

## 5. Publish

Only with `publish` in the arguments or the owner's go-ahead in this conversation: `gh release edit v<version> -R arpan404/ace --draft=false --latest`. Done when `gh release view` shows it published and `gh api repos/arpan404/ace/releases/latest -q .tag_name` is `v<version>`.

## Report

The release URL, draft or published, the asset names and sizes, and the verification results from the build.

## Known limits

- Intel and Linux desktop builds need matching machines; this skill ships the Apple silicon app only.
- Apps from 0.0.2 and earlier can't update in place; they show "is available" with Download, which opens the release page.
