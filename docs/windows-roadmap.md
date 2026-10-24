# Windows desktop execution log

Owner: Luseefor. Started 2026-10-22. Target: the complete local Windows app,
with the same user workflows as macOS. Source implementation and native runtime
verification are tracked separately. The canonical release scope and workstreams
are in [PR #1315](https://github.com/arpan404/ace/pull/1315), its
[Windows release plan](https://github.com/arpan404/ace/blob/ace/windows-release-setup/docs/plans/windows-release.md)
and [ADR 0095](https://github.com/arpan404/ace/blob/ace/windows-release-setup/docs/adr/0095-native-windows-daemon.md).
Those documents are on the PR branch until it merges. This log tracks bounded
implementation slices and evidence against that plan. An unchecked item remains
unfinished even when adjacent work has landed.

## Relationship to the release plan

| Canonical workstream               | Execution slices here                                 |
| ---------------------------------- | ----------------------------------------------------- |
| Workspace confinement              | W01, W04, W05, W06                                    |
| Process ownership                  | W03, W10, W11 and provider workflow checks            |
| Terminal                           | W02, W09, W10                                         |
| Release, install, service, updates | W07, W13 and distribution checks                      |
| Browser                            | Browser workflow checks in W14/W15                    |
| Computer use                       | Computer-use workflow checks in W14/W15               |
| Desktop                            | W12, W16, W17 and desktop integration checks          |
| Daemon gaps                        | W12 and file, Git, account and plugin workflow checks |
| CI                                 | W08, W15, W18                                         |

The canonical plan also names ripgrep input, secure command discovery, pinned Git
spawns, provider installers and owner-only ACLs. These remain required even where
the slices below group them into broader workflow checks. Its upload containment
fix stays owned by PR #1315; this branch does not duplicate that implementation.

PowerShell discovery is now wired into Windows terminal startup in `1c952d125`:
`pwsh`, then `powershell`, then `ComSpec`. Runtime staging uses the shared
`runtime/node.exe` helper. Both remain subject to native Windows verification.

## Delivery order

Build complete functional workflows first, using the shared web renderer and
existing design system throughout. Fix UI problems that block a workflow in
the same slice. After the functional gate passes, run a dedicated macOS/Windows
visual and interaction comparison. This avoids maintaining a second Windows UI
while the runtime is still changing.

Ship Windows x64 and ARM64. The available Mac is Apple Silicon with VMware
Fusion 25.0.1, so local live testing uses Windows 11 ARM64. x64 needs its own
native CI build and process tests; ARM64 emulation is not x64 native evidence.

## Review and commit loop

Implementation proceeds in this worktree. The owner has resumed delegation for
small bounded tasks, with parent review and separate commits and pushes for each
behavior.
Each behavior gets a separate commit and immediate push after its source review
and applicable static checks. Verify author and committer as
`Luseefor <sapanakosansar18@gmail.com>` before every commit. Record native
verification only after matching Windows execution passes.

Workers write behavior tests and run static checks during development, following
the repository's documented policy. The owner explicitly requested live Windows
tests in VMware. The full repository `bun run check` remains the merge gate.
No recorder runs are included in this work.

## Foundation and build

- [ ] W00: reclaim rebuildable caches, download and verify an official Windows
      11 ARM64 ISO, create an isolated Fusion VM, install guest tooling and
      establish a repeatable command and screenshot path. Preserve personal data.
- [ ] W01: document the Windows filesystem design against primary Win32 sources.
- [x] W02: select Windows shells without inheriting a POSIX `SHELL`.
- [x] W03: read Windows kernel process creation identity and distinguish absence
      from permission failure. Preserve PID-reuse safety.
- [x] W04: add the Windows descriptor build and native read/metadata operations,
      preserving root confinement against junctions, links, path aliases and races.
- [ ] W05: add directory enumeration, mutations, permissions, flush and error
      semantics. Update consumers only where Windows requires a different contract.
- [x] W06: clean `bun install` succeeds on both Windows architectures without
      skipping descriptor.node, node-pty/ConPTY, koffi or SQLite. Document the
      native build prerequisites. The parent owns interim Windows checks until CI
      takes over in W08.
- [ ] W07: stage pinned Windows Node, complete node-pty/ConPTY assets and runtime
      package closure; keep archive/update schema changes separate from desktop
      runtime staging. Build NSIS installers on matching native runners.
- [ ] W08: add bounded Windows CI checks, native tests and installer smoke checks.

Dependencies: W04/W05 follow W01; W06 follows W04/W05; W07 follows W06 and
the terminal backend. CI can begin with an explicit foundational scope, expanding
as those dependencies land. A partial CI job is not the Windows release gate.

## Local execution and recovery

- [ ] W09: ConPTY backend behind the existing terminal interface, with input,
      resize, Unicode output, scrollback and completion semantics.
- [ ] W10: terminal process ownership, graceful stop, forced stop, close retry,
      detached descendants and daemon-death cleanup. Exercise actual Windows
      process trees, including PowerShell, cmd and npm wrappers.
- [ ] W11: safe Windows process inventory recovery and Job Object assignment;
      preserve permissions and PID identity, handle denied joins and crash races.
      Cover `provider-kit/src/process-inventory.ts` alive/kill and
      `daemon/src/builtin-skill-processes.ts` groupGone/owner checks explicitly.
- [ ] W12: daemon startup/adoption, token/home paths, locks, logs, SQLite workers,
      child runtime, readiness and shutdown work locally. Enable Windows managed
      targets only after the dependencies pass.
- [ ] W13: per-user background startup/service lifecycle, installed `ace.cmd`,
      PATH discovery and restart/reconnect. No administrator-only app requirement.

Dependencies: W09 follows W02; W11 follows W03; W12 follows W05, W07, W10,
W11. W13 follows W12.

## Complete feature workflows

Each row needs Windows evidence for creation, normal operation, cancellation,
restart/reconnect and errors where applicable.

| Workflow                        | Acceptance gate                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers and accounts          | Installed CLI discovery, login, model/effort selection, account isolation, streaming, approvals, stop and recovery for every supported Windows provider. Resolve Cursor SDK support explicitly rather than silently enabling it. |
| Threads and delegation          | New thread, worktree, queue, steer, questions, subagents, background tasks, whole-tree status, history/replay, archive and search.                                                                                               |
| Projects, files and attachments | Drive paths, Unicode, long paths, case aliases, reserved names, UNC policy, listing, search, edit, upload/download, safe replace, trash and Git-ignore behavior.                                                                 |
| Git and forge                   | Worktrees, status, diffs, checkpoints, restore, commit, push, PR flows, conflicts, cancellation and orphan cleanup using the person's installed Git/gh.                                                                          |
| Terminal                        | cmd and PowerShell with streamed I/O, resize, reconnect, retained output and safe tree shutdown.                                                                                                                                 |
| Browser                         | Embedded and installed browser integration, navigation, tabs, auth dialogs, uploads/downloads, screenshots, input, video, crash recovery and extension/native-host installation.                                                 |
| Computer use                    | Signed Rust helper, capture, UI Automation, input, approval/takeover, DPI/multiple displays, secure desktop refusal, recordings and helper crash recovery.                                                                       |
| Automation and Offshift         | Durable scheduling, sleep/restart recovery, delegated work, cancellation, evidence and notification behavior.                                                                                                                    |
| Remote and Fleet                | Pair/revoke, Tailscale/LAN policy, pinned connections, reconnect, cross-machine delegation and phone/web clients attached to the Windows daemon.                                                                                 |
| Desktop integration             | Notifications/actions, tray, background mode, login, deep links, Explorer folder entry, clipboard, drag/drop, editor launch, diagnostics and support export.                                                                     |
| Devices                         | Supported Windows Android/device tools work; macOS-only iOS simulator/Xcode actions remain available through a paired Mac with explicit capability reporting.                                                                    |
| Plugins and visualizations      | Install/discovery, skills, MCP, scoped tools, sandboxed visualizations and artifact persistence.                                                                                                                                 |
| Distribution                    | Clean install, repair/uninstall, data preservation, Authenticode, update download/drain/install, rollback/error reporting and both architectures.                                                                                |

- [ ] W14: feature-by-feature audit turns every remaining platform assumption
      into a bounded fix with a named test or manual acceptance step.
- [ ] W15: all applicable workflow gates above pass in a clean Windows VM and
      matching x64 CI, with macOS/Linux regression checks passing.

## UI parity and release

- [ ] W16: compare macOS and Windows at matched viewport sizes and content in
      light/dark themes. Check title-bar overlap, drag regions, system caption
      buttons, menus, shortcuts, file dialogs, terminal fonts, accessibility,
      100/125/150/200 percent scaling and multiple displays.
- [ ] W17: verify the full workflow in the signed installed app, not only the
      dev renderer. Capture bounded performance evidence for idle CPU/RSS,
      transcript streaming, history, browser video and computer-use capture.
- [ ] W18: run the full repository gate, complete the release checklist and
      publish a ready-for-review PR with accurate native evidence and limitations.

## Evidence ledger

| Slice                                   | Pushed commit            | Verification                                                                                                                                                       |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Execution plan                          | `b4595adf2`              | Reconciled with canonical PR #1315                                                                                                                                 |
| W01 filesystem design and W04 read core | `14984e067`              | Source reviews and host probe passed; MSVC compilation and native execution pending                                                                                |
| W02 shell selection and W09 ConPTY      | `f7cb073d8`, `1c952d125` | PowerShell discovery, ConPTY admission, I/O and Job ownership implemented; terminal formatting, lint and typecheck passed; Windows execution pending               |
| W03 process identity                    | `ce7e13f9b`              | Real owner SID and creation time implemented; static checks passed; native marshalling and recovery pending                                                        |
| Windows lexical policy                  | `20f57c084`              | Source reviews and static checks passed; behavioral execution pending                                                                                              |
| W05 metadata and enumeration            | `96a5cabb2`              | Handle-relative stat and bounded multi-batch listing implemented; source review, static checks and host probe passed; native execution, mutations and ACLs pending |
| W07 Node runtime staging                | `7eea3fbed`              | Official ARM64/x64 downloads staged and checksum-verified on macOS; native packaging pending                                                                       |
| W07 ConPTY assets                       | `99e62306c`              | Shared module/DLL/worker staging implemented; source and static checks passed; installed-runtime validation pending                                                |
| Shared synchronous command discovery    | `11169c6e4`              | Source reviews and static checks passed; used by terminal shell selection                                                                                          |
| W10 retained Job ownership              | `f8cbc6af2`              | Source reviews and static checks passed; native descendant and kill-on-close fixtures pending                                                                      |
| W08 native CI foundation                | `f27337e26`              | Native x64/ARM64 build and fixture workflow committed; YAML, formatting and lint passed; no successful runner result yet                                           |
| W00 VM                                  | `094e7f182`              | Windows 11 ARM64 boots to desktop and VMware Tools runs; SSH and native compiler/test execution remain pending                                                     |

The full Windows app is not usable yet. Production filesystem mutations and ACLs,
safe process recovery, managed desktop daemon startup, packaging/install/update,
and the remaining canonical workflows still block functional acceptance. No full
workstream is marked complete from source changes alone.

The VM uses encryption and a virtual TPM. After Windows booted from its disk,
the used installer images were removed, recovering about 8 GiB. The older VM
from PR #1315 has not been located.

Related contracts: [desktop shell](adr/0054-desktop-shell.md),
[distribution](adr/0041-packaging-and-distribution.md),
[Windows process launch](adr/0091-windows-process-launch.md),
[screen helper](adr/0048-windows-screen-helper.md),
[launch acceptance checklist](verification/windows-launch-checklist.md).

## Latest native verification

[Run 39874497061](https://github.com/arpan404/ace/actions/runs/39874497061)
on `d6eb04ff1` passed on both native Windows x64 and ARM64, each with
14 files and 122 tests. This includes MSVC compilation, ConPTY, retained Job
ownership, process identity, filesystem metadata, exclusive creation and mkdir.
It does not establish the clean-install, production integration or installed-app
gates.

The next W05 slice adds handle-relative `unlinkAt` and `removeDirectoryAt`,
including type errors, nonempty-directory rejection, junction removal without
following its target, and pinned-parent behavior after ancestor replacement.
[Run 39876189647](https://github.com/arpan404/ace/actions/runs/39876189647)
verified commit `564848785` on native x64 and ARM64, each passing 14 files and
124 tests. Rename, ACLs and production descriptor integration remain unfinished.

Local formatting, lint, source-size, protocol, generated-bundle checks and
incremental typechecking passed. The dependency check reported no violations,
with its existing warning about incomplete TypeScript 7 support. `bun run check`
stopped at three UI style violations in untouched files: `pair-device.tsx`,
`update-restart-dialog.tsx` and `turn-end.tsx`. Later full-gate steps did not run.

## Rename and replacement slice

The independent Windows core now implements same-parent `renameAt` with
replacement and `renameExclusiveAt` without replacement. Both validate each
name and use the opened source plus the pinned parent for the destination.
Reparse sources are moved themselves. Native fixtures cover flushed publication,
identity preservation, collisions, invalid names, missing sources and ancestor
replacement. Native x64 and ARM64 each pass 15 files and 127 tests on `9488f1304`, including
these three rename fixtures. [Run 39878029237](https://github.com/arpan404/ace/actions/runs/39878029237).
Production descriptor integration and private-file ACLs remain blockers.

Metadata Node-API callbacks now live in a separate binding module so the entry
module stays below its 400-line source budget. This is not daemon activation.

## Next production integration gates

1. Rename is now verified on native x64 and ARM64. The initial x64 run rejected
   all three Win32 rename calls while the existing 124 tests passed. Commit
   `9488f1304` changes the call to native `NtSetInformationFile`, keeping the
   same record and pinned handles. Both architectures pass all 127 tests.
2. Wire the verified owner-only ACL operations into production private-file
   readers and writers, preserving the identity of the descriptor actually used.
   `chmod(0600)` and numeric uid comparisons do not provide that contract on
   Windows. The native check/set fixtures pass against actual Windows tokens.
3. Integrate the Windows backend into `descriptor.ts`, identity comparison and
   `build.ts`, then pass clean installs without `--ignore-scripts` on both
   architectures. The current `build.ts` still explicitly rejects Windows.
4. Ripgrep stdin is now verified. Replace `fchdir` Git execution with confined
   Windows process startup and complete secure command discovery. Do not
   substitute pathname joins for pinned access.
5. Complete process recovery and daemon startup/reconnect/shutdown before
   enabling the Windows desktop managed target.
6. Complete service, installer, updater, browser, computer-use and provider
   workflows, then run installed-app and UI parity acceptance from the canonical
   plan. The bounded foundation suite does not satisfy those workflow gates.

## Private files and Windows search input

Small delegated tasks implement protected owner-only DACL checks and setting,
streamed process stdin, and Windows ripgrep routing. The parent reviewed the
results and committed each behavior separately:

| Commit      | Slice                                                  | Evidence                                                                                                        |
| ----------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `2de5073a5` | Current-token owner SID and exact protected DACL check | Native compilation passed; initial fixtures hit a PowerShell module-loading failure.                            |
| `f034a422b` | Direct .NET fixture ACL setup                          | Avoids host PowerShell module state; native rerun pending.                                                      |
| `5f34c1e3f` | Backpressured stdin and child cleanup                  | Five real-process tests pass locally, including cancellation, early exit and producer failures.                 |
| `63a8049e8` | Owner-only DACL setting                                | Uses the same opened object for setting and postcheck; native confirmation pending.                             |
| `0b3859ad5` | Confined Windows ripgrep stdin transport               | Four real-ripgrep transport tests plus 15 existing search/pipe tests pass locally; native confirmation pending. |

The source probe and incremental typecheck pass. Windows search now uses
per-file stdin instead of `/dev/fd`, with a bounded benchmark recording its
spawn overhead. Production descriptor/identity/build integration, pinned Git,
daemon activation and the remaining release workflows are still required.

Fixture follow-up `a37bc0a4f` sets the expected TokenUser owner explicitly before
setter tests; default creation can choose an admin group as owner. The setter
continues to refuse taking ownership. UI token fixes in `add98a010` clear all
three existing `check:ui` failures. Live browser inspection verified the pairing
sheet opens and keyboard focus reaches its first control without console errors.
The full repository gate is now running past that former blocker.

## Native ACL and stdin verification

[Run 39880850603](https://github.com/arpan404/ace/actions/runs/39880850603)
verifies `a37bc0a4f` on native Windows x64 and ARM64: each passes **18 files and
144 tests**, including ACL check/set, hardlink and junction refusal, pinned
ancestor security, streaming input cancellation/early exits and real ripgrep
stdin behavior. The native benchmark completes on both architectures. Its
64-small-file medians are 573 ms on x64 and 768 ms on ARM64; four 256 KiB
files take 39 ms and 52 ms. These are transport observations, not application
release performance acceptance.

`c7dec0451` makes production directory, file and exclusive-create intent explicit
without activating the Windows backend. Its 20 existing pinned-directory,
confinement and file tests pass, as do scoped formatting/lint and workspace
typechecking. This is a prerequisite for mapping those operations to Windows
without relying on unavailable POSIX `O_DIRECTORY` flags. Lossless identity,
private-file consumer checks, backend loading/build and pinned Git remain gated.

## Base integration and renewed verification

`33dcc7ed7` merges `main` through `843c31d9b`, preserving the Windows changes.
The sole content conflict was the generated protocol manifest, regenerated from
the combined sources. The branch is mergeable again. A frozen-lockfile install
and the native workspace/terminal rebuild pass on the Mac.

[Run 39882666616](https://github.com/arpan404/ace/actions/runs/39882666616)
verifies that merged commit on native Windows x64 and ARM64. Each passes
MSVC compilation and **18 files / 144 tests**. This repeats the native evidence
after base integration; it still does not establish clean Windows installation
or production daemon activation.

`2d733eb0a` removes a duplicate foreign-thread setup in the iOS media fixture;
the existing cross-thread media refusal assertion passes. Base integration
exposed ten arbitrary font sizes in the forge rich-text renderer. `3d986e635`
maps them to design tokens, clearing the UI gate. Its 13 existing rich-content
tests pass. Browser inspection of the rich PR fixture confirms keyboard labels
and commit references use 11.5 px, with no console errors. Both fixes are saved
separately from the Windows runtime work.

The full repository check is running on the merged branch with those fixes.
No complete full-gate pass is recorded yet. The next identity change must cover
both opened-descriptor comparisons and path/metadata proofs with lossless values;
changing only the stored root identity would leave rounded-number comparisons
in production confinement checks.

## Production identity and descriptor security prerequisites

`ef16a3188` makes POSIX descriptor, path and metadata identity comparisons
lossless. Exact device/inode strings accompany numeric metadata, preserving JSON
serialization. Four precision/serialization tests and 23 existing behavior tests
pass. Windows still needs native FileId mapping, ACL consumers and backend build
selection before production activation.

`6cf2fced8` fixes a real regression found during repository validation. Sidebar PR
buttons read the shared sidebar record instead of subscribing to every thread's
transcript. The original cold-cache search tests pass unchanged, alongside 30
PR/New thread tests. Live browser inspection confirms correct PR navigation.

`f81b463f3` integrates main through `e4b58b77f`; the generated protocol manifest
was regenerated after the only conflict. Reviewed base-integration repairs update
stale UI/iOS expectations while preserving refusal, persistence and navigation
assertions. Each repair was committed and pushed separately.

[Run 39911893770](https://github.com/arpan404/ace/actions/runs/39911893770)
verifies runtime commit `c4e6f7722` on Windows x64 and ARM64. Each passes real
MSVC compilation and 18 files / 144 tests. This does not establish production
backend integration or clean installation.

`76253a305` adds `checkPrivateFd` for the actual open file used by a caller. It
borrows the handle, reuses the strict owner-only checks and leaves descriptor
ownership with Node. Two new fixtures cover filename replacement in both
directions, hardlink/directory refusal and invalid/closed descriptors. Source
checks pass; all ten private-file tests skip on this Mac.
[Run 39913429652](https://github.com/arpan404/ace/actions/runs/39913429652)
verifies the change with MSVC compilation and 18 files / 146 tests on each of
native Windows x64 and ARM64.
`9593219a5` shares the existing TokenUser SID and owner-only ACL builders.
`32cdaa2e5` adds `createPrivateFileAt`: the protected owner-only descriptor is
passed to exclusive `NtCreateFile`, then the returned data descriptor is checked
before it is returned. Existing names are refused without changing their ACLs.
The shared handle-to-fd bridge keeps allocation and cleanup in Node's libuv.
Four new fixtures cover public parent inheritance, collisions, pinned ancestor
replacement and invalid names/descriptors. They skip on macOS.
[Run 39986601606](https://github.com/arpan404/ace/actions/runs/39986601606), pinned
to `3f2e415b4`, passes native MSVC compilation and 19 files / 150 tests on each
of x64 and ARM64, including all four new private-creation cases. Production
reader/writer integration and Windows identity mapping remain required.

`42c4f2ad6` adds an explicit Windows stat source to `Descriptor`, combining
numeric display metadata with parsed native volume/file-ID strings from the
same caller-held fd. The default POSIX binding and Windows production gate stay
unchanged. All 24 host regressions pass; four new Windows fixtures cover native
identity/JSON, pathname replacement, directory metadata and malformed-ID refusal.
[Run 39989547686](https://github.com/arpan404/ace/actions/runs/39989547686), pinned
to `d37988808`, passes MSVC compilation and 20 files / 154 tests on both native
x64 and ARM64. All four descriptor-stat fixtures execute and pass.

The two-worker full gate finished with 2,764 files passed, 38 failed and 26
skipped; 17,005 tests passed and 59 failed, plus one unhandled error. It exited 1
after 7,650 seconds. Some failures used old tests before repairs committed during
the scan. Reviewed fixture repairs are saved individually; process and browser
failures remain under diagnosis. A clean full-gate pass is still required.

`af468b240` fixes a real history-paging deadlock when the loaded transcript fits
its viewport. Three paging cases, 15 scroll-state cases and the existing
transcript regression pass, with web typechecking and live browser verification.
`5cbf5cc63` removes repeated full tree expansion inside each retention protection
check, preserving fresh live checks. All 14 retention tests pass on this branch;
the 300-thread case still takes 186 seconds in isolation and needs further work.

## Opened metadata and path observations

`8b98a871e` adds metadata-only child descriptors without following reparse
points. Its first native run exposed two assumptions: Windows refused an
ancestor rename while its child was open, and Node's `fstat` classified an
opened junction as a directory. `84859b865` separates the replacement scenarios
and adds `statFd`, sharing the native metadata query with `statAt`. The explicit
Windows stat adapter now takes identity and type from the same native handle.
[Run 39994964122](https://github.com/arpan404/ace/actions/runs/39994964122), pinned
to `84859b865`, passes MSVC compilation and **21 files / 158 tests on each of
native x64 and ARM64**, including all four metadata-open fixtures.

`c0469a9a2` adds an explicit Windows filesystem adapter for path `stat` and
`lstat`. It follows the target for `stat`, observes the leaf itself for `lstat`,
and closes parent and child descriptors after the same-handle observation.
Its four native fixtures cover junction identity, drive roots, replacement and
error cleanup. They skip on macOS. [Run 39996443611](https://github.com/arpan404/ace/actions/runs/39996443611),
pinned to `c0469a9a2`, passes MSVC compilation and **22 files / 162 tests per
architecture**, including all four new path-adapter cases on x64 and ARM64.
Default bindings, private-file consumers and clean installation remain gated.

Repository validation also found a real provider-close ordering bug.
`09c995298` closes finished settled sessions before aborting their lifetime,
preserving the native checkpoint for resume. All 17 release, settlement,
background-child and reopen-during-close cases pass. Formatting, lint, size,
generated bundles, incremental and full source typechecking pass. Browser
quality and restart failures remain under diagnosis; no clean full repository
gate is recorded.

`f34ae1f44` separates the existing native binding schema and lazy loader from
shared descriptor operations. The extraction preserves loading behavior and
passes 23 existing host cases. This prepares a separate Windows binding schema;
it does not select that backend yet.

## Default backend and clean-install verification

`c6f692419` adds the separate Windows native binding. `566492794` adds held-fd
private metadata and ACL repair. [Run 39999625209](https://github.com/arpan404/ace/actions/runs/39999625209)
passes native MSVC compilation and **23 files / 166 tests on each architecture**,
including all four new security fixtures.

`89c2989f8` connects the normal build entry to the existing Windows compiler,
producing `dist/descriptor.node` from explicit full Node headers, matching
`node.lib` and MSVC. `cd62df05f` enables real frozen dependency installation with
postinstall scripts in CI. Build prerequisites are listed in the
[workspace research](research/windows-workspace-backend.md#production-selection-and-build-prerequisites).

`11859cd89` selects Windows native operations and metadata for the shared
workspace, uses real ACL checks and private creation for pinned private files,
and acquires held private metadata descriptors for upload repair. Publication
flushes staged data before rename; Windows directory/power-loss limits remain
explicit. All 35 applicable host confinement/read/list/search/publication cases
pass. Four new Windows integration cases await
[run 40000660283](https://github.com/arpan404/ace/actions/runs/40000660283), pinned
to that commit, together with the first real clean-install attempt on both
architectures. W06 remains unchecked until that evidence passes.

A fresh two-worker `bun run check` is running. Confined Git startup, absolute
upload writers, process recovery and daemon/installed-app workflows remain on
the critical path. The full local Windows app is not usable yet.

## Native install and cold-start milestone

[Run 40006284111](https://github.com/arpan404/ace/actions/runs/40006284111), pinned
to `97945b24b`, passes the real frozen install, native MSVC builds and **29 files /
179 tests on each of Windows x64 and ARM64**. This completes W06's dependency
install gate, including real ConPTY/Koffi use and a SQLite WAL/locking/persistence
case. W02/W03/W04 record the implemented shell selection, kernel identity and
native descriptor read/metadata gates from this suite. Their later workflow and
installed-app gates remain separate.

The public daemon API cold-boots, reports its listener ready, closes, and restarts
from the same home with its workspace, token and host identity preserved. This
fixture substitutes provider discovery boundaries and starts no provider session.
It proves a clean-start baseline, not inventory crash recovery or managed desktop
acceptance. Full W12 remains unfinished, including enforced Windows data-home
ACLs and remaining private/absolute-path consumers.

Private plugin markers, held upload-metadata repair including readonly recovery,
private skill leases, and default workspace operations also pass. The expanded
run first exposed two fixture assumptions: attributes-only handles did not block
rename, and public skill evidence throws `EACCES`. The corrected test requests
actual directory read access and preserves the refusal. Both pass in this run.

The GUID-cwd fixture keeps Node and Git in the intended directory after remapping
an owned scratch drive alias, and a directory read handle without delete sharing
blocks renaming that object. These are prerequisites for the confined Git launcher;
production still uses its POSIX helper and is not Windows-ready.

Global and full source typechecking pass. The fresh full repository gate has
reached process tests and is still running; no complete pass is claimed.

## Protected data-home milestone

[Run 40011792770](https://github.com/arpan404/ace/actions/runs/40011792770),
pinned to `4e9e6aa04`, passes **32 files / 190 tests on both native architectures**.
This adds atomic protected private-directory creation, private home creation/reuse,
refusal of existing unsafe homes, private daemon identity-file persistence and
inherited/hardlink refusal. The clean daemon restart case stays green after these
changes. The adopted-directory security check now uses a volume/file-ID open
and validates the complete identity, replacing the failing reopen path.

The browser ownership fixture's epoch timestamp caused an inactivity settle
during Chromium startup. `526faeb1f` uses the thread creation clock; isolated
SIGTERM and SIGKILL privacy/restart flows both pass with assertions unchanged.
The current full repository run has reported browser streaming/conformance and
video-sharpness failures and remains running. It is not a clean repository pass.
W12 remains open for remaining absolute-path writers, recovery/adoption and
installed-app workflows. Confined Git also needs the empty-cwd reparse test
described in the filesystem research; rename sharing alone is insufficient proof.

## Windows browser and computer-use verification

[Run 40060060692](https://github.com/arpan404/ace/actions/runs/40060060692),
pinned to `ed2166d3f`, passes **33 files / 191 tests on x64**, including real
Chrome VP8 encoding, viewer acknowledgements and WebCodecs decoding. Its ARM64
browser starts successfully but times out before playable video arrives. The
existing 190 foundation tests still pass there. Both architectures pass the real
Rust helper's named-pipe negotiation and typed refusal test, plus 23 Rust behavior
tests. Four interactive Rust tests remain ignored.

The initial Chrome refusal came from the isolated Windows test environment.
Creating standard `AppData/Local` and `AppData/Roaming` directories clears startup
without changing Chrome's debugging protection. A later x64 run also passes
playback after removal of the temporary native-folder probe.

`5fa4e9ca0` lets session computer tools rejoin an existing Windows window by exact
executable identity. It defaults agent input to foreground and refuses unsupported
background or URL requests before acquisition. Four host process tests cover the
entry, ownership, unavailable targets and ambiguous window selection.

[Run 40061062541](https://github.com/arpan404/ace/actions/runs/40061062541),
pinned to `7bd9e6f71`, passes all **33 files / 191 tests on ARM64**. Its x64
playback trace exposes an extension startup race: Chrome exposes the target before
its script defines `aceVideo`. `cfdd1b4a2` resumes the attached target and waits
for its exports within the existing startup budget. Two regression tests and real
Chrome software playback pass locally. Native confirmation is pending in
[run 40075224334](https://github.com/arpan404/ace/actions/runs/40075224334).

The owned WinForms fixture now reaches WGC capture startup on both architectures,
but the helper exits before the first JPEG. `b11b545b3` preserves the original
failure, native stderr and exit status in the next run. Unicode UIA editing,
real pointer/keyboard input, hardware-codec quality and installed desktop
acceptance remain unverified. W14/W15 remain open.

Full source typechecking passed. The full repository check completed with
**2,797 files passed, 9 failed and 40 skipped**, **17,064 tests passed and 11 failed**,
and five uncaught errors. It is not a clean full gate. Browser failures include
streaming timeouts, a missing cursor keyframe and refused orphan recovery; other
failures remain in repository isolation, tool budgets, measurement, worktree
progress and preview concurrency.
