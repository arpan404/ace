# iPhone browser-parity verification — 2026-10-20

Physical destination: iPhone 12 Pro, iOS 26.6.1, Xcode 26.3 (17C529).
The owner required physical-phone testing. The browser reference was the running fake-daemon
web app at 390 × 844 CSS pixels; the phone used its actual paired daemon over Tailscale.
Private conversation captures and pairing material are not committed.

## Corrected behavior

- The native pinned transport reached a self-signed daemon after the ATS configuration fix.
  A valid pinned unauthenticated ticket request returned 401; a changed pin was refused.
  Authenticated inbox, projects, plugin catalog, provider accounts, source-control readiness,
  CLI discovery, device inventory and full-message reads completed on the phone.
- A revoked saved pairing was renewed through the normal pinned pairing API. Explicit
  Projects and Accounts grants were needed in addition to administrator access. Superseded
  authorizations created during verification were revoked; old device databases were retained.
- Inbox creation sits on the project-filter row. The thread header has Back, title, options,
  Work and panel. Both composers keep attachment, message, model and send together. The
  keyboard stays below the controls, and draft text is retained on a failed send.
- Active tools use the browser's shared grouping rules. Narration appears between groups;
  reasoning opens in place. Ended runs cannot leave an unfinished thought marked active.
  Finished work still folds; edit-summary blocks no longer repeat individual edit rows.
  Markdown tables render as tables. Long messages and thoughts have authenticated full-text
  reads, bounded to 8 MiB of UTF-16 text.
- Browse exposes projects/history, search, automations, usage, providers/accounts, CLI skills,
  plugins/reviews/source editing, source control, devices and settings. Search can inspect a
  bounded historical message window without replacing the live transcript tail.

## Results and local evidence

| Run                              | Result                                                                          | Local artifact                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Initial native run               | 17 passed; pinned connection failed under ATS                                   | `/tmp/ace-iphone-native-1.xcresult`                                    |
| TLS repair                       | Physical pinned endpoint reached successfully                                   | `/tmp/ace-iphone-tls-fixed.log`                                        |
| Pairing repair                   | Passed; old authorization was absent on the daemon                              | `/tmp/ace-iphone-renewal-5.xcresult`                                   |
| Broad native attempt             | 211 tests; 3 failed: fixture unavailable, inbox wait race, invalid test fixture | `/tmp/ace-iphone-native-4.xcresult`                                    |
| Focused native recheck           | 20 tests in 5 suites passed after corrections                                   | `/tmp/ace-iphone-native-5.xcresult`                                    |
| UI tour                          | 5 of 6 passed; host setup notices were incorrectly treated as transport errors  | `/tmp/ace-iphone-tour-4.xcresult`                                      |
| UI correction                    | Both live transcript and machine-tool checks passed                             | `/tmp/ace-iphone-tour-5.xcresult`                                      |
| Source control and CLI discovery | 4 native tests plus 1 UI flow passed; final labeled form rechecked              | `/tmp/ace-iphone-tools-6.xcresult`, `/tmp/ace-iphone-tools-7.xcresult` |

Eight distinct connected-phone UI flows passed across the final focused runs: projects,
live conversation, machine tools, task composer/keyboard, content search, thread composer/
keyboard, source control/CLI discovery, and Mac computer-use preferences. Captures were inspected in
`/tmp/ace-iphone-tour-4-attachments`, `/tmp/ace-iphone-tour-5.xcresult` and
`/tmp/ace-iphone-tools-6-attachments`. No provider tasks, simulator boots or remote-device
input were started by these real-daemon checks. The early layout probe's exact test text
was removed from the draft without changing its other fields.

The Mac computer-use follow-up passed 29 native tests in six suites and one UI flow
on the phone (`/tmp/ace-iphone-screen-9.xcresult`). It covers screen/device stream isolation,
H.264, native JPEG decoding, viewport mapping, pinned authenticated services and the Mac
permissions/preferences UI. The preceding run caught a JPEG fixture whose UIKit scale did
not match its wire dimensions; correcting the fixture passed without relaxing the decoder.
Computer-use captures are in `/tmp/ace-iphone-screen-8-attachments`.

## Checks and limits

The signed physical-phone build, formatting, lint, bounded TypeScript check, size guard,
UI-value guard, dependency boundaries, generated theme, browser annotation and extension
checks passed. Dependency-cruiser warned about TypeScript 7 support. The protocol-reference
check reported an already-stale `docs/protocol/manifest.json`; no protocol schemas changed.
The complete root `bun run check` was not run because it includes host-side Vitest tests,
contrary to the owner's physical-phone-only instruction.

The old loopback-fixture contracts require a separately reachable fixture and are not claimed
as physical passes. The native device decoder was exercised with real H.264 on the phone;
this is not a GPU FPS or input-latency measurement. Remote simulator input on this Mac still
needs serve-sim/idb; Android tools are absent. These are host setup notices in Devices.
Mac desktop sessions now have native viewing, controller, input, background/foreground,
secure-input and recording controls over the shared screen channel. Live capture/control
was not started: the Mac still needs Screen Recording and Accessibility grants.
Full VT terminal emulation and APNs remain separate native capability gaps. Mutating plugin installation/account flows were implemented but not
performed against the owner's live environment by this read-only tour. This record does
not claim exhaustive browser parity or production performance certification.
