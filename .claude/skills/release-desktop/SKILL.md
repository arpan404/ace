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

## 2. Build

```sh
bun install --frozen-lockfile
unset ACE_VERSION
set -a; source ~/.ace-release/release.env; set +a
bun run desktop:package
```

`unset ACE_VERSION` matters: a shell started by ace inherits `ACE_VERSION` from the running app, and the packager prefers it over `package.json`, so the build gets the old version's name.

It takes 10–20 minutes (notarization is most of it); run it in the background and wait for it to exit. Done when it exits 0 and `apps/desktop/dist/release/` holds `ace-<version>-arm64.dmg` and `ace-<version>-arm64-mac.zip`.

Then build and sign the update manifest the app's update check reads. It needs Node 24.13.0 exactly: download `node-v24.13.0-darwin-arm64.tar.gz` from nodejs.org into a new temp directory, check it against the `darwin-arm64` hash in `tools/release/src/node-runtime.ts`, and put its `bin` first on `PATH` for these two commands only.

```sh
bun run --filter @ace/release build <version> darwin-arm64 "$ACE_RELEASE_PUBLIC_KEY_FILE"
bun run --filter @ace/release sign tools/release/dist/darwin-arm64.json ~/.ace-release/ace-key.pem tools/release/dist/darwin-arm64.sig
```

Done when `tools/release/dist/` holds `darwin-arm64.json`, `darwin-arm64.sig` and the archive named in the manifest's `archive` field.

## 3. Verify

Against `apps/desktop/dist/release/mac-arm64/ace.app`:

- `codesign --verify --deep --strict --verbose=2` passes.
- `spctl -a -vv` prints `accepted` and `source=Notarized Developer ID`.
- `xcrun stapler validate` passes.

Done when all three pass. A failure stops the run with the output shown to the owner.

## 4. Draft release

```sh
gh release create v<version> -R arpan404/ace --draft \
  --title "ace <version>" --notes "<notes>" \
  apps/desktop/dist/release/ace-<version>-arm64.dmg \
  apps/desktop/dist/release/ace-<version>-arm64-mac.zip \
  tools/release/dist/darwin-arm64.json tools/release/dist/darwin-arm64.sig \
  tools/release/dist/<archive from the manifest>
```

Notes are what users read when the app offers the update, so write them for users, in Markdown: a platform and install line, then `## New`, `## Improved` and `## Fixed` sections covering the user-facing changes since the previous release tag (`git log --oneline <previous-tag>..HEAD`, merged PR titles). Done when `gh release view v<version>` shows `draft: true` with all five assets.

## 5. Publish

Only with `publish` in the arguments or the owner's go-ahead in this conversation: `gh release edit v<version> -R arpan404/ace --draft=false`. Done when `gh release view` shows it published.

## Report

The release URL, draft or published, the two asset names and sizes, and the three verification results.

## Known limits

- Intel and Linux builds need matching machines; this skill ships Apple silicon only.
