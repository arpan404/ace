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

Implementation proceeds directly in this worktree. Existing bounded worker
results have been integrated; new delegation is paused at the owner's request.
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
