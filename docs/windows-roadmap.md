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
- [ ] W02: select Windows shells without inheriting a POSIX `SHELL`.
- [ ] W03: read Windows kernel process creation identity and distinguish absence
      from permission failure. Preserve PID-reuse safety.
- [ ] W04: add the Windows descriptor build and native read/metadata operations,
      preserving root confinement against junctions, links, path aliases and races.
- [ ] W05: add directory enumeration, mutations, permissions, flush and error
      semantics. Update consumers only where Windows requires a different contract.
- [ ] W06: clean `bun install` succeeds on both Windows architectures without
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
