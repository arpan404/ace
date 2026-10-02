# Linux helper delivery verification

The repository owner's latest instruction prohibits executing tests, probes, benchmarks, Docker harnesses and mutations before merge. This report describes static review of the delivered revision. Earlier development results are not evidence for this revision. Every runtime claim below **needs run at merge**.

## Static checks

- Workspace TypeScript typecheck: passed.
- Workspace lint: passed.
- Formatting: applied with `bun run fmt`.
- Source-size check: passed.
- `cargo check --target x86_64-unknown-linux-gnu --tests`: passed using Rust 1.91.1 from macOS.
- `cargo check --target aarch64-unknown-linux-gnu --tests`: passed using Rust 1.91.1 from macOS.
- The macOS cross-check excludes C compilation and native linking. PipeWire ABI compilation and static release linking need a Linux run at merge.

## Behavior tests provided

All entries are **not executed (tests run at merge)**.

- Backend selection prefers native Wayland over XWayland and rejects a missing display.
- Damage scheduling coalesces changes, respects fps and removes its timer while idle.
- Pointer bounds reject negative, nonfinite and exclusive right/bottom edges.
- Portal source/device masks and version control advertised support and persistence.
- Protocol caps reject oversized commands, invalid fps and unsupported versions while preserving v1 commands.
- Binary packets preserve JPEG payloads and reject oversized headers.
- Private restore tokens rotate atomically; public files and symlinks are rejected.
- Tree node/depth/byte caps prune work and report truncation.
- Tree queries reject a different target and semantic fallback uses current window geometry.
- Private frame sockets require a private parent and reject symlink endpoints.
- Fake helper processes negotiate platform, deliver v2 frame metadata and return typed errors over real Unix sockets.
- One helper survives inspections and sequential captures; semantic tools enforce controller ownership and negotiated support.
- Failed stop removes the session and replaces its unusable helper.
- Revoked capture permission drops the helper before an explicitly requested replacement session.
- Paired viewers cannot enable, approve or control; paired operators still cannot change approvals.
- The ephemeral Debian harness exercises actual JPEG capture, XDamage changes, XTest clicks/keys/modifier release, Unicode EditableText insertion, AT-SPI tree pruning, stable refs, search and actions.
- Manual GNOME/KDE consent, restore, revocation, chooser/source identity and scaling cases are listed in README.md.

## Mutation cases

These are designed test failures, **not executed (tests run at merge)**. The machine-readable list is `bench/mutation-results.json`.

1. Select X11 when both DISPLAY and WAYLAND_DISPLAY exist: backend-selection test.
2. Keep dirty set after a frame: idle damage-scheduling test.
3. Ignore the next fps deadline: damage coalescing test.
4. Accept x equal to width: exclusive coordinate-bounds test.
5. Derive pointer permission from the keyboard bit: portal device-mask test.
6. Require RemoteDesktop v3 instead of v2 for persistence: portal version test.
7. Accept fps 31: malformed-command test.
8. Allow depth 33: tree-cap test.
9. Permit read scope to approve: paired-viewer authorization test.
10. Retain the shared helper after failed stop or permission revocation: fake-process replacement tests.
11. Compute fallback from the previous window origin: current-geometry fallback test.
12. Ignore the endpoint parent mode: real Unix-socket ownership test.

## Performance evidence

No numbers are claimed for this revision. All measurements **need run at merge**.

| Metric | Measurement path | Status |
| --- | --- | --- |
| Idle CPU / changing-window CPU at 10 fps | `bench/session.py` through Docker harness | needs run at merge |
| Encode latency | `bench/encode.rs` | needs run at merge |
| UI tree latency on a large GTK app | Docker integration harness | needs run at merge |
| RSS | Docker integration harness | needs run at merge |
| TypeScript frame fan-out | `packages/screen/bench/stream.ts` | needs run at merge |

## Scope and remaining limitations

- X11 whole-display capture is refused because application filtering cannot be enforced under ADR 0011. Approved-window capture is implemented.
- Wayland loads the desktop's installed PipeWire library and SPA modules. Static CRT linkage is requested by the release build, but the Wayland runtime is not self-contained. Both native architecture release builds need run at merge.
- Wayland downscaling uses bounded software conversion. X11 uses server-side XRender before XShm readback.
- The portal chooser owns capture identity; AT-SPI independently targets one approved executable/window. Their identity can differ and capabilities state this limitation. Pointer fallback is disabled on Wayland.
- Capture ends on explicit stop. Automatic suspension after the last viewer leaves is not implemented; viewer disconnect releases controller ownership.
- The existing macOS helper remains v1-compatible. This Linux change does not implement macOS AX v2 or Windows UI Automation.
- Tool schemas and a session/owner-scoped handler are exported. The MCP host must bind an approved session to authenticated agent attribution before registering them.
- Docker cleanup removes only task-named containers/images. The earlier disposable task VM was removed; no task-owned Docker image or container was created. Build caches are managed by Docker, without pruning the user's resources.
