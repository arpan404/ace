# Daemon releases

The runtime is pinned to Node 24.13.0. The four archive hashes in `src/build.ts` come from the [official SHASUMS256.txt](https://nodejs.org/dist/v24.13.0/SHASUMS256.txt). Bun's lockfile pins the JS and macOS node-pty inputs. Vendored third-party dependencies retain license notices in the bundles and distribution files.

Build from a committed checkout after `bun install --frozen-lockfile`, with Node 24.13.0 on PATH. The builder rejects other host runtime versions so tar/gzip output uses a fixed implementation. Generate a release authority outside the repository, or use an existing authority from the release secret manager. The build accepts only the public key. Keep the private key offline and outside this checkout, and never pass its contents as an argument or environment variable.

```sh
openssl genpkey -algorithm ED25519 -out /secure/offline/ace-key.pem
openssl pkey -in /secure/offline/ace-key.pem -pubout -out /secure/ace-public.pem
bun run --filter @ace/release build 0.1.0 darwin-arm64 /secure/ace-public.pem
bun run --filter @ace/release build 0.1.0 darwin-x64 /secure/ace-public.pem
```

node-pty 1.1.0 includes macOS prebuilds but no Linux prebuilds. On each Linux target, run `bun run --filter @ace/release native linux-x64` or `native linux-arm64` with a pinned C++ toolchain. This builds the locked package against Node 24.13.0 headers, records compiler provenance and emits checksum-pinned input JSON. Publish its `build/Release/pty.node` and `spawn-helper` as immutable release inputs. Record their SHA-256 values in a JSON input file. Do not reuse a macOS binary, a different Node ABI or an unverified download. Linux glibc compatibility follows the selected Node distribution and the native build host. Musl and Windows are outside this release matrix.

```json
{
  "linux-x64": {
    "pty": "/verified/linux-x64/pty.node",
    "ptySha256": "64 lowercase hex digits",
    "helper": "/verified/linux-x64/spawn-helper",
    "helperSha256": "64 lowercase hex digits"
  }
}
```

```sh
bun run --filter @ace/release build 0.1.0 linux-x64 /secure/ace-public.pem /verified/native-inputs.json
bun run --filter @ace/release build 0.1.0 linux-arm64 /secure/ace-public.pem /verified/native-inputs.json
bun run --filter @ace/release sign dist/darwin-arm64.json /secure/offline/ace-key.pem dist/darwin-arm64.sig
# Sign each target, then prepare publication without uploading anything.
node tools/release/src/publication.ts tools/release/dist https://github.com/arpan404/ace/releases/download/v0.1.0 /secure/ace-public.pem
```

Builds write sorted, fixed-metadata tarballs and a file checksum manifest. Repeating a build with identical checkout, lockfile, public key and native inputs must produce identical archive hashes. Sign the exact manifest bytes, including the final newline. Publish all four archives, four manifests, four signatures, install.sh and install.sh.sha256 together. The desktop app should spawn `bin/node ace.mjs start` from this artifact and pass ACE_HOME. It must not load node-pty into Electron itself.

The first public release needs a reviewed production public key and native Linux inputs. No production authority has been fabricated for development. Key rotation requires an intentional release signed by the old authority before users accept the new pinned key. A stolen signing key requires an out-of-band recovery release and installer announcement.

## Install and operate

Install.sh requires curl, tar and a SHA-256 utility. The trusted installer pins all four archive hashes independently of the feed. After that checksum succeeds, the bundled Node runtime verifies the Ed25519 manifest signature before installation. This works on macOS without an OpenSSL 3 dependency. Download the installer and verify its hash against the value in the trusted release announcement, then invoke `sh`. A release announcement can provide this as one shell command. Never pipe it into sudo. The installer verifies the manifest signature and archive checksum before executing bundled code.

The daemon lives under `${ACE_HOME:-$HOME/.ace}`. Add its `bin` directory to PATH. Run `ace status` for authenticated health, `ace service status` for service-manager state, and `ace service install|start|stop|uninstall` for management. The LaunchAgent runs during GUI login. The systemd user unit runs while the user's manager is active; ace does not enable lingering. Linux logs use `journalctl --user -u ace`; daemon output uses `.ace/logs/output.log` and `error.log` on both platforms, capped at 8 MiB each with one previous generation. macOS supervisor diagnostics use `daemon.log` and `daemon.err.log`. Capture the provider CLI PATH when installing the service. Daemon port, listen, advertised-host and log-level settings are captured after validation; provider credential variables are excluded. Reinstall after changing it.

`ace update check` authenticates the latest stable GitHub release, or the `preview` release tag for preview installations. `ace update apply` refuses active, waiting, approval or unresponsive threads. `ace update recover` restores a pending transaction without network access. Startup schedules that recovery automatically, even with daily updates disabled. `ace update apply --drain` closes admission and waits up to five minutes for natural completion. It does not cancel providers. No release is accepted unless its version increases and target/channel match. Preview prereleases at the same numeric version currently require explicit promotion to stable; automatic ordering of prerelease labels is intentionally conservative.

Automatic daily updates are enabled by default. Set ACE_AUTO_UPDATE=0 when installing the service to select manual updates. Linux launches the updater in a separate transient user unit, so stopping ace.service cannot kill it. The external updater survives its own service stop. A retained update journal keeps the candidate's command admission closed until health succeeds; rerunning the updater restores the previous binary and all pre-migration SQLite snapshots. A dead updater PID can be reclaimed under a serialized recovery lock. A crash before the PID file exists or during lock recovery fails closed and requires removing the abandoned lock directory after confirming no updater runs.

Uninstall stops and disables only ace's service and removes its executable pointers and releases. SQLite databases, access tokens and configuration stay in ACE_HOME. Delete that directory separately if you intend to erase data.

## Verification

Use fake service-manager executables only. Run `bun run test packages/service/src apps/daemon/src/maintenance.server.test.ts -- --maxWorkers=2`, then `bun run check`. The non-gating hash benchmark is `bun run --filter @ace/release bench`. Run `node tools/release/src/smoke.ts tools/release/dist/darwin-arm64` on its target host. Packaging smoke checks must run the artifact on each target, open a real PTY, start on an isolated ACE_HOME/port, query status, and terminate it. Do not launch provider CLIs or the recorder.
