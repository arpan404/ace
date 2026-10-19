# iOS simulator progress, 2026-10-19

Work continues on `ace/continue-ace-ios`. This branch recovers the stopped
`ace/ios-emulator-parity` work without changing its original worktree, then adds
review fixes in separate commits. All commits use the owner's Git identity.
No provider sessions or recorder runs were used.

## Changes

- Canonical inbox labels distinguish questions, approvals and child waits. Project
  badges, a visible thread header, file-count chips and native tool shortcuts are
  available. Completed-test chips still need authoritative result metadata.
- Machine screens use the selected SDK connection for preferences, usage, prompt
  files, provider sign-in and automations. Sign-in handles the CLI's Enter prompt.
  Cron edits preserve expression, time zone and schedule anchor. Phone profiles
  include their instructions explicitly in the first task message.
- Phone appearance supports system/light/dark mode and separate custom palettes.
  Save and reset update the observed palette without resetting navigation. Shared
  status and diff colours remain fixed. Return-to-send is a persisted preference.
- Terminal output credits native delivery, resumes by byte offset and discards
  replayed bytes. Gaps reset partial OSC/CSI parsing before rendering later output.
  The renderer has basic VT support and bounded scrollback, not full terminal
  colour or alternate-screen emulation.
- Thread tools include skills/commands, MCP controls, durable conversation branches
  and a browser preview. View-only previews skip forbidden evaluation. Browser
  images remain still screenshots; live streaming is future work.
- Published images use native decoding. Published HTML runs through the existing
  shared sandbox in a nonpersistent WKWebView without native message handlers.
- Local Live Activities use canonical whole-tree status and require a fresh inbox
  confirmation before ending; cached Done during reconnect stays Syncing.
  Foreground renewal belongs
  to the persistent navigation stack, including while a thread is open. Offline
  and stale content asks the person to reopen ace. Remote activity updates through
  APNs remain unimplemented.
- The app has a privacy manifest and `scripts/archive.ts`. Signed distribution and
  TestFlight upload were not attempted in this continuation.

[ADR 0089](../../adr/0089-ios-native-tools-and-local-activities.md) records the service
boundary, local activity decision and limits.

## Verification

Environment: Xcode 26.3, iPhone 17 Pro simulator on iOS 26.3. One simulator build or
test command at a time, `-jobs 4`, parallel Xcode testing disabled. The isolated
spike uses port 9851. The real-daemon fixture uses ports 4610 through 4613.

- `bun run test --project unit apps/ios/bridge`: 106 tests passed in 20 files.
- `bun run test --project unit packages/ui-core/src/mobile-inbox.test.ts`: 15 passed.
- `bun run --filter @ace/ios typecheck` and `theme:check`: passed.
- Six real-daemon TLS and pairing tests passed. Offline replay survived phone
  runtime replacement and two daemon restarts, including a check from a fresh
  cache. The fixture requests fresh pairing links per case and uses an allowed
  disposable project under the user's home directory.
- The first full native contract run passed 158 of 159 tests. The failing regression
  test expected stale resync credit to move backward after two replayed bytes.
  Its assertion now requires monotonic progress. A clean rerun passed all 159.
  After the completion-fence fixes, the suite passed all 170 tests in 32 suites
  (`TerminalPerformanceTests` excluded). This includes missing-confirmation decoding,
  coalesced-ready row invalidation and revocation decisions for queued endings.
  After the final bridge producer change and rebuild, all 19 inbox/activity tests
  passed again. The bridge regression holds real pump acknowledgments across
  offline→ready and separates the new connection fence from delayed row frames.

- Eight feature-tour UI tests passed. The new-thread UI test initially failed on an
  off-screen attachment row; after scrolling before asserting hittability, the
  focused rerun passed. The corrected test still opens the picker and verifies
  “Choose File.”
- The canvas viewport regression passed: the 30-pixel base button is at least 29
  native points tall, and tapping it advances the authored interaction to Step 2.
- The first repository gate failed an icon-cache teardown race and asynchronous
  attachment-tray assertion, both corrected. It also reported web failures while
  simulator builds competed for resources. That failed run was stopped. The file
  management suite subsequently passed all eight tests with two workers.

- `bun apps/ios/scripts/archive.ts --unsigned`: passed. The archive contains an
  arm64 `app.ace.ios` app, its embedded `app.ace.ios.activity` WidgetKit extension,
  matching build versions and the app's privacy manifest. This verifies local
  packaging; signed distribution and App Store validation were not attempted.

Run the full repository gate with `ACE_TEST_WORKERS=2` after stopping the
spike/real-daemon fixtures and simulator. The pull request records its final result
and the CI results.

## Simulator captures

These captures come from this worktree's successful UI runs. The canvas capture
includes the viewport correction and an exercised interaction.

| Screen                                | Capture                                  |
| ------------------------------------- | ---------------------------------------- |
| Inbox with canonical attention labels | [Inbox](parity-inbox.png)                |
| Approval and composer with keyboard   | [Keyboard](parity-approval-keyboard.png) |
| Native terminal output                | [Terminal](parity-terminal.png)          |
| Published interactive HTML            | [Canvas](parity-canvas.png)              |
| Machine settings                      | [Settings](parity-machine-settings.png)  |
| Machine usage                         | [Usage](parity-usage.png)                |

## Remaining work

Physical iPhone pairing over Tailscale, rendering, hitches, input latency and memory
plateau remain unverified. Simulator display-link cadence does not prove physical
presentation FPS. Runtime Lock Screen/Dynamic Island behavior, real browser
control and real provider sign-in completion still need dedicated verification.

Remote push, background remote activity updates, live browser streaming, full
terminal emulation, screen/device control, temporary chats and image-generation
services remain outside this progress batch. Web-search toggles and completed-test
chips need authoritative protocol data. Signing, App Store Connect validation and
TestFlight rollout remain separate distribution work.

## Reproduce

From `apps/ios`, run `bun run generate`, then start `bun run spike:daemon` with
`ACE_IOS_SPIKE_PORT=9851`. Start `bun run e2e:pairing` in another terminal for the
real-daemon cases. Codes refresh per case; no provider process starts.

Use the same simulator destination for `build-for-testing` and
`test-without-building`. Set `TEST_RUNNER_ACE_IOS_SPIKE_PORT=9851`, select
`-only-testing:AceTests` for native contracts and `-only-testing:AceUITests/ParityUITests`
for the feature tour. `TerminalPerformanceTests` is a separate simulator benchmark;
it is not physical-device performance evidence.

Run `bun scripts/archive.ts --unsigned` for a device archive without distribution
signing. An unsigned archive cannot be uploaded to TestFlight.
