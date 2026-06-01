# Agent Release Guide

This runbook is for future coding agents preparing an ace release. It assumes the
agent is operating from the repository root.

## Non-Negotiable Rules

- Do not publish macOS desktop artifacts unless they are signed and notarized.
- Local macOS signing and notarization values must come from `.env.local` or the
  process environment. Never print, commit, or paste secret values into logs.
- Use `bun run test` if tests are needed. Never run `bun test`.
- Before considering release-prep work complete, run `bun fmt`, `bun lint`, and
  `bun typecheck`.
- Do not use `--allow-dirty`, `--skip-gates`, `--skip-build`, or `--skip-push`
  for a real publish unless the user explicitly asks for that exception.

## Primary Release Paths

There are two supported release paths:

1. GitHub Actions release:
   - Triggered by pushing a tag matching `v*.*.*`.
   - Can also be triggered with `workflow_dispatch` and a version input.
   - Uses repository secrets for signing, notarization, npm publishing, and the
     release version bump.
2. Local all-platform desktop release:
   - Script: `scripts/local-desktop-release.sh`.
   - Package script: `bun run release:desktop:local`.
   - Builds macOS on the host and Linux/Windows in Docker.
   - Loads `.env.local` before validating macOS signing requirements.
   - Publishes desktop GitHub Release assets only; it does not publish the npm
     CLI package or create the final version bump commit.

Use the local release path when GitHub Actions should not build desktop
artifacts, or when validating the full packaging flow before publishing.

## Required Local Prerequisites

- macOS host for macOS DMG/ZIP packaging.
- Docker Desktop with `linux/amd64` support.
- `bun`, `node`, `git`, `docker`, and `gh` available on `PATH`.
- `gh` authenticated with permission to create and update releases.
- Clean tracked working tree.
- Release tag points at `HEAD`, or the command includes `--create-tag`.
- Repo-root `.env.local` contains the macOS signing and notarization values.

Minimum `.env.local` shape for local desktop release:

```dotenv
ACE_DESKTOP_SIGNED=true

# Use CSC_LINK + CSC_KEY_PASSWORD for a p12 bundle, or use CSC_NAME for an
# installed Developer ID Application identity.
CSC_LINK=...
CSC_KEY_PASSWORD=...
# CSC_NAME=Developer ID Application: Example Team (TEAMID)

# Local releases expect APPLE_API_KEY to be a path to the .p8 key file.
APPLE_API_KEY=/absolute/path/to/AuthKey_KEYID.p8
APPLE_API_KEY_ID=...
APPLE_API_ISSUER=...

# Optional metadata, not a Developer ID entitlement requirement.
APPLE_TEAM_ID=...
ACE_DESKTOP_MAC_TEAM_ID=...

# Optional. If omitted, the script asks gh for the current repo.
ACE_DESKTOP_UPDATE_REPOSITORY=owner/repo
```

GitHub Actions differs slightly: the `APPLE_API_KEY` secret stores the raw `.p8`
contents, and the workflow writes it to a temporary key file.

## Local Release Procedure

1. Confirm the intended version and tag:

```bash
git status --short
git rev-parse HEAD
```

2. Run the required quality gates before making or publishing a release:

```bash
bun fmt
bun lint
bun typecheck
```

3. Build a local release without publishing:

```bash
bun run dist:desktop:all -- --tag vX.Y.Z --create-tag
```

4. Inspect the generated assets in `release-local/publish`:

```bash
find release-local/publish -maxdepth 1 -type f -print
shasum -a 256 release-local/publish/*
```

5. Publish only after the user confirms the version and artifacts are correct:

```bash
bun run release -- --tag vX.Y.Z
```

Use `--previous-tag vA.B.C` when release notes should compare against a specific
previous tag:

```bash
bun run release -- --tag vX.Y.Z --previous-tag vA.B.C
```

## What The Local Script Must Do

The local script is expected to:

- Load `.env.local` without echoing secret values.
- Require `ACE_DESKTOP_SIGNED=true`.
- Require either `CSC_LINK` or `CSC_NAME`.
- Require `CSC_KEY_PASSWORD` when `CSC_LINK` is used.
- Require `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
- Build signed and notarized macOS `arm64` and `x64` DMG/ZIP artifacts using
  Developer ID hardened-runtime entitlements. Do not add App Group or keychain
  access group entitlements unless a matching provisioning profile is packaged.
- Build Linux `x64` and `arm64` AppImage artifacts in Docker.
- Build Windows `x64` and `arm64` NSIS artifacts in Docker.
- Merge macOS and Windows updater manifests before publishing.
- Print SHA-256 checksums for all publish assets.
- Create or update the GitHub Release only when `--publish` is passed.

If any macOS signing or notarization value is missing, stop and fix the
environment. Do not bypass the failure for a real release.

Windows and Linux browser authentication does not add release-time secrets. The
desktop runtime handles Chromium WebAuthn account selection plus HID, USB, and
serial device selection dialogs at runtime.

## GitHub Actions Release Procedure

1. Confirm GitHub Actions secrets are configured:

```text
CSC_LINK
CSC_KEY_PASSWORD
APPLE_API_KEY
APPLE_API_KEY_ID
APPLE_API_ISSUER
APPLE_TEAM_ID
RELEASE_APP_ID
RELEASE_APP_PRIVATE_KEY
```

2. Confirm npm trusted publishing is configured for the `ace` package and
   `.github/workflows/release.yml`.

3. Create and push the release tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

4. Watch `.github/workflows/release.yml` until these jobs pass:

```text
preflight
build
publish_cli
release
finalize
```

5. Verify the GitHub Release contains installers, update metadata, and blockmap
   files for the built platforms.

## Post-Release Verification

- Download the macOS artifacts from the GitHub Release and confirm they open on
  Apple Silicon and Intel Macs.
- Confirm macOS update metadata includes one merged `latest-mac.yml`.
- Confirm Linux metadata includes `latest-linux.yml` and
  `latest-linux-arm64.yml`.
- Confirm Windows metadata includes the merged `latest.yml`.
- Confirm the npm package version matches the release version.
- Confirm the release version bump commit lands on `main` after the workflow
  finalizes.

## Troubleshooting Rules

- If macOS signing fails, re-check `.env.local` for required values and confirm
  `APPLE_API_KEY` points to an existing `.p8` file.
- If notarization fails, treat the release as failed. Do not publish the macOS
  artifact.
- If the local script says the tag does not point at `HEAD`, stop and ask the
  user before moving or recreating the tag.
- If Docker packaging fails because dependency state is stale, remove the named
  Docker volumes only after confirming with the user.
- If GitHub Release upload fails after artifacts were built, re-run with
  `--skip-build --publish` only when the existing `release-local` output is known
  to be from the same commit and version.
