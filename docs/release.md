# Release Checklist

This document covers how to run desktop releases from one tag, first without signing, then with signing.

## Fast path: local signed desktop release

Use this when you want to build every desktop asset locally and publish a GitHub
Release through `gh`.

Prerequisites:

- macOS host.
- Docker Desktop running.
- `gh auth status` succeeds for the target repository.
- `.env.local` exists at the repo root. Start from `.env.local.example`.
- The working tree is clean except ignored generated release output.

Build all release assets without publishing:

```bash
bun run dist:desktop:all -- --tag vX.Y.Z --create-tag
```

Publish the release with generated changelog notes:

```bash
bun run release -- --tag vX.Y.Z
```

Generate notes against an explicit previous tag:

```bash
bun run release -- --tag vX.Y.Z --previous-tag vA.B.C
```

Reuse already-built assets after an upload failure:

```bash
bun run release:desktop:local -- --tag vX.Y.Z --skip-build --publish
```

The publish command creates or updates the GitHub Release for the tag, uploads
the files from `release-local/publish`, and writes notes containing `What's
Changed`, release-prep commits, and a full changelog link.

## Required local `.env.local`

Copy `.env.local.example` to `.env.local` and fill in the real values. The local
release script loads this file automatically and does not print secret values.

Minimum macOS signing/notarization values:

```dotenv
ACE_DESKTOP_UPDATE_REPOSITORY=owner/repo
ACE_DESKTOP_SIGNED=true

CSC_LINK=base64-encoded-developer-id-application-p12
CSC_KEY_PASSWORD=p12-export-password

APPLE_API_KEY=/absolute/path/to/AuthKey_KEYID.p8
APPLE_API_KEY_ID=KEYID
APPLE_API_ISSUER=issuer-id-uuid

# Optional metadata for consistent local/CI logs.
APPLE_TEAM_ID=TEAMID1234
ACE_DESKTOP_MAC_TEAM_ID=TEAMID1234
```

Windows signing is optional. If Azure Trusted Signing values are absent, the
local script still builds Windows installers, but they are not Authenticode
signed.

Important macOS signing rule:

- Do not add App Group or keychain access group entitlements to Developer ID
  builds unless a matching provisioning profile is packaged. The fixed release
  path uses Electron Builder's default hardened-runtime entitlements and
  notarization.

## What the release tooling does

- Trigger: push tag matching `v*.*.*`.
- Runs quality gates first: lint, typecheck, test.
- The local desktop release path builds six artifacts:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Linux `arm64` AppImage
  - Windows `x64` NSIS installer
  - Windows `arm64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Versions with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain `X.Y.Z` releases are marked as the repository's latest release.
- Includes Electron auto-update metadata (for example `latest*.yml` and `*.blockmap`) in release assets.
- Publishes the CLI package (`apps/server`, npm package `ace`) with OIDC trusted publishing.
- Signing is optional and auto-detected per platform from secrets.

## Desktop auto-update notes

- Runtime updater: `electron-updater` in `apps/desktop/src/main.ts`.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `ACE_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Temporary private-repo auth workaround:
  - set `ACE_DESKTOP_UPDATE_GITHUB_TOKEN` (or `GH_TOKEN`) in the desktop app runtime environment.
  - the app forwards it as an `Authorization: Bearer <token>` request header for updater HTTP calls.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - `latest*.yml` metadata
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one `latest-mac.yml` before publishing the GitHub Release.

## Desktop browser authentication notes

- macOS Developer ID builds must not add App Group or keychain access group
  entitlements unless the app is also packaged with a matching provisioning
  profile. The release build intentionally uses Electron Builder's default
  hardened-runtime entitlements for notarized Developer ID distribution.
- `APPLE_TEAM_ID` and `ACE_DESKTOP_MAC_TEAM_ID` are optional local metadata
  values. They are useful for keeping local and CI signing logs consistent, but
  they are not required for the fixed Developer ID release path.
- Windows and Linux builds do not need a signing-time WebAuthn entitlement. The
  in-app browser uses Chromium's platform WebAuthn path where available and
  provides runtime selection dialogs for discoverable credentials, HID devices,
  USB devices, and serial ports.
- The browser session removes Electron/app tokens from its user agent and exposes
  a same-session sign-in window for auth pages. That window uses the same
  persistent browser partition as embedded tabs, so successful auth can flow back
  through shared cookies and storage without opening the user's default browser.
- Browser-extension-only password managers are best-effort in Electron. The app
  auto-discovers known unpacked Chromium password-manager extensions from local
  profiles and also accepts explicit directories with
  `ACE_DESKTOP_BROWSER_EXTENSION_DIRS`, but Electron supports only a subset of
  extension APIs and does not run Safari extensions.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow publishes the CLI with `bun publish` from `apps/server` after bumping
the package version to the release tag version.

Checklist:

1. Confirm npm org/user owns package `ace` (or rename package first if needed).
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - set `apps/server/package.json` version to `X.Y.Z`
   - build web + server
   - run `bun publish --access public`

## 1) Dry-run release without signing

Use this first to validate packaging locally, or to validate non-macOS release paths before wiring signing.

Important:

- Unsigned macOS artifacts cannot be used for in-app auto-update. ShipIt will reject them with a code-signature validation error.
- The GitHub release workflow now requires Apple signing secrets for macOS release tags so broken auto-update metadata is not published.

1. Build local unsigned artifacts as needed:
   - `bun run dist:desktop:dmg:arm64`
   - `bun run dist:desktop:dmg:x64`
   - `bun run dist:desktop:linux`
   - `bun run dist:desktop:linux:arm64`
   - `bun run dist:desktop:win`
   - `bun run dist:desktop:win:arm64`
2. Do not publish unsigned macOS artifacts to the updater GitHub release feed.
3. Download each artifact and sanity-check installation on each OS.

## Local Linux Docker Builds

For local validation from macOS, build the Linux AppImage in Docker:

```bash
bun run dist:desktop:linux:docker
```

The script builds a local builder image, mounts the repo at `/workspace`, and uses Docker volumes for Linux `node_modules` and Bun's package cache. This avoids accidentally packaging macOS-native dependencies into the Linux artifact.

Useful overrides:

```bash
ACE_DESKTOP_ARCH=arm64 bun run dist:desktop:linux:docker
ACE_DESKTOP_OUTPUT_DIR=release-linux-docker bun run dist:desktop:linux:docker
bun run dist:desktop:linux:docker -- --build-version 0.2.0-local.1 --verbose
```

For Windows Docker packaging, use the all-platform local release script below. It installs Wine/Wine32 and disables Electron Builder native rebuilds for Windows so packaged runtime dependencies use their Windows prebuilds.

## Local All-Platform Desktop Release

Use the local release driver when GitHub Actions should not build the desktop artifacts. It builds macOS on the host, builds Linux and Windows in Docker, collects updater metadata, and can optionally create the GitHub Release.

Prerequisites:

- macOS host for DMG/ZIP packaging.
- Docker Desktop with `linux/amd64` support.
- `gh` authenticated with `repo` scope.
- `.env.local` at the repo root. Start from `.env.local.example` and fill in
  macOS signing/notarization values:
  - `ACE_DESKTOP_SIGNED=true`
  - `CSC_LINK` and `CSC_KEY_PASSWORD`, or `CSC_NAME` for an installed Developer ID identity
  - `APPLE_API_KEY` as a local path to the `.p8` file, plus `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`
  - optionally `APPLE_TEAM_ID` and `ACE_DESKTOP_MAC_TEAM_ID` for Apple log consistency
- A clean working tree, except ignored/generated release output.
- The release tag must point at `HEAD`, or pass `--create-tag` to create it.

Dry-run build without publishing:

```bash
bun run dist:desktop:all -- --tag v0.2.0 --create-tag
```

Publish the release after local artifacts are built:

```bash
bun run release -- --tag v0.2.0
```

Useful options:

```bash
bun run release -- --tag v0.2.0 --previous-tag v0.2.0-beta
bun run dist:desktop:all -- --tag v0.2.0 --output-dir release-v0.2.0
bun run release -- --tag v0.2.0 --norelease
bun run dist:desktop:all -- --tag v0.2.0 --parallel 1
bun run dist:desktop:all -- --tag v0.2.0 --parallel 4
bun run release:desktop:local -- --tag v0.2.0 --skip-build --publish
bun run release:desktop:local -- --tag v0.2.0 --skip-gates --publish
bun run release:desktop:local -- --tag v0.2.0 --allow-dirty --publish
```

What the script does:

1. Loads `.env.local` without printing secret values.
2. Verifies the tag points at `HEAD` or creates it with `--create-tag`, unless `--norelease` is passed for a local-only build.
3. Runs `bun fmt`, `bun lint`, and `bun typecheck` unless `--skip-gates` is passed.
4. Runs `bun run build:desktop` unless `--skip-build` is passed.
5. Requires macOS signing/notarization env before mac packaging.
6. Builds desktop targets concurrently by default. The automatic concurrency is capped by logical CPU cores and total memory, assuming roughly four cores and 2 GiB RAM per target build. Pass `--parallel <jobs>` to override it, including `--parallel 1` for one target at a time:
   - macOS `arm64` DMG and ZIP on the host.
   - macOS `x64` DMG and ZIP on the host.
   - Linux `x64` AppImage in Docker.
   - Linux `arm64` AppImage in Docker.
   - Windows `x64` NSIS installer in Docker with Wine, Wine32, and NSIS.
   - Windows `arm64` NSIS installer in Docker with Wine, Wine32, and NSIS.
     Parallel target output is prefixed with the target name so concurrent build logs stay readable.
7. Collects release assets into `release-local/publish`.
8. Merges per-arch macOS updater manifests into one `latest-mac.yml`.
9. Keeps Linux updater metadata split by channel file (`latest-linux.yml` for `x64`, `latest-linux-arm64.yml` for `arm64`) and merges Windows updater metadata into one `latest.yml`.
10. Prints SHA-256 checksums for every publish asset.
11. With `--publish`, pushes the tag, creates the GitHub Release if missing, or updates the existing release in place for the same tag, uploads assets, and generates release notes in this shape:

- `What's Changed`
- PR title, author, and PR link
- direct release-prep commits
- full changelog link

The script handles git worktrees by mounting the common `.git` directory into Docker at its original absolute path. This is required because worktree `.git` files point outside the checked-out worktree, and Docker otherwise cannot resolve the tag/commit metadata used by the desktop build.

Local Windows Docker details:

- The Windows Docker image is defined in `scripts/docker/desktop-windows.Dockerfile`.
- It installs Wine, `wine32:i386`, NSIS, Bun, and `node-gyp`.
- `build-desktop-artifact.ts` disables Electron Builder's native rebuild step for Windows because Linux-to-Windows `node-gyp` cross-rebuilds are unsupported. Runtime packages must provide Windows prebuilds.

Local release caveats:

- macOS artifacts must be signed and notarized. The local release script fails before mac packaging if required values are missing.
- Windows artifacts built without Azure Trusted Signing credentials are not authenticode-signed.
- Docker builds use named volumes for platform-specific `node_modules`; remove those volumes if dependency state needs a completely fresh rebuild.

## Local release command quick reference

```bash
# Build every desktop asset locally without publishing.
bun run dist:desktop:all -- --tag vX.Y.Z --create-tag

# Publish every locally built desktop asset to GitHub Releases with generated
# changelog notes. This also builds first unless --skip-build is passed.
bun run release -- --tag vX.Y.Z

# Re-upload existing output after a failed release upload.
bun run release:desktop:local -- --tag vX.Y.Z --skip-build --publish
```

The publish command uses `gh release create` or `gh release edit` plus
`gh release upload --clobber`, and writes release notes with `What's Changed`,
release-prep commits, and a full changelog link.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_TEAM_ID`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create `Developer ID Application` certificate.
3. Export certificate + private key as `.p12` from Keychain.
4. Base64-encode the `.p12` and store as `CSC_LINK`.
5. Store the `.p12` export password as `CSC_KEY_PASSWORD`.
6. Optionally record the Apple Developer Team ID as `APPLE_TEAM_ID` and
   `ACE_DESKTOP_MAC_TEAM_ID` for consistent local/CI signing logs.
7. In App Store Connect, create an API key (Team key).
8. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
9. Re-run a tag release and confirm macOS artifacts are signed/notarized.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Bump app version as needed.
3. Create release tag: `vX.Y.Z`.
4. Push tag.
5. Verify workflow steps:
   - preflight passes
   - all matrix builds pass
   - release job uploads expected files
6. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets are populated and non-empty.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
