# iPhone browser parity verification, 2026-10-20

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
  Work and panel. Both composers give the message its own full-width line, with attachment, model/reasoning
  and Send below it. The keyboard stays below the controls, and draft text is retained on
  a failed send.
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

## Chat layout and long conversations

The phone chat now uses a full-width message field above a compact attachment/model/send row,
a smaller send/stop glyph inside its full touch target, an opaque header with quiet tool icons,
right-aligned user messages and plain assistant responses. Per-message timestamps moved into
the message menu alongside Copy and Share. Fenced code has a language header and Copy.
The first-message screen uses the same composer and a separate project selector.

Incoming updates follow the latest message while the person stays at the bottom. Reading older
content pauses following and exposes Jump to latest. The first scroll-check failures were an
accessibility identifier inherited from the transcript container, not a missing visible button.
The final phone check targets the button independently and returns to the live tail.

Earlier messages now open a separate bounded history window. Earlier/later page controls stay
reachable below the content. This avoids repeatedly trying to fill an already-full live cache.
Historical full-message and media reads resolve their authenticated item through the shared SDK
without admitting the history into the live tail. A physical-phone regression failed before
that resolver change; all five connected-phone service tests passed after it.

New project and Clone repository retain their form and command identity across relaunch.
The identity is persisted before submission; retrying an uncertain request reuses it. Clone
progress and cancellation use the shared daemon operations. The phone tests read both forms
and the host defaults; they did not create or clone a repository on the live machine.

- `/tmp/ace-iphone-chat-10.xcresult`: 17 native tests in four suites and three UI flows passed.
  The native cases cover message drafts, first-message drafts, Markdown and project draft
  recovery, including refusing a submission whose draft cannot be saved.
- `/tmp/ace-iphone-chat-14.xcresult`: the final composer/model/scroll-control flow passed.
  Its individually filtered Swift Testing method selected zero native tests; those are covered
  by the whole-suite history run below.
- `/tmp/ace-iphone-history-red-15.xcresult`: four service tests passed and the new historical
  full-message regression failed before the item resolver fix.

- `/tmp/ace-iphone-history-16.xcresult`: all five native service tests passed, including the
  historical full-message regression. Its history UI attempt exposed an entry that depended
  on a delayed live-cache flag. History is now always in the conversation menu.
- `/tmp/ace-iphone-history-19.xcresult`: history paging in both directions and return to the
  live composer passed on the phone. The test compares displayed content between pages.
  Earlier UI attempts assumed a non-overlapping page boundary; the SDK intentionally keeps
  context on both sides of the target. The composer/scroll check also passed in run 16.

Across these focused runs, 22 native tests in five suites and four UI flows passed for the
chat/project follow-up. Only the connected physical iPhone was used. Captures are local under
`/tmp/ace-iphone-chat-10-attachments` and the corresponding final xcresult attachments.
Phone captures may include private conversation content and are not committed.

## Conversation loading correction

The previous captures and timing checks missed the partial loading screen reported by the
owner. The app used the 2,200-item benchmark limit, while the service tests connected with a
200-item limit. A new read-only phone regression goes through `MachinesModel`, the shipping
connection path. `/tmp/ace-iphone-production-red-21.xcresult` failed because opening the
current conversation eagerly admitted 1,710 items. The normal paired app now retains the
latest 200 items and reads older content through the existing paged history reader. The
explicit benchmark mode still supports its larger workload.

Initial readiness is queued after both item rows and block layout. The UI reveals that
snapshot together, uses message-shaped skeletons while waiting, and retains a parent's
previous readable snapshot until its replacement is ready. Live work groups are separate
list rows rather than one large nested vertical layout. Missing single items no longer
turn into misleading "View work" disclosures. The UI wait now observes the transcript's
actual ready value, replacing a loading-label absence check that could pass before loading
started.

`/tmp/ace-iphone-coherent-green-22.xcresult` passed 31 native tests in four suites
and three UI flows on the connected iPhone. The native run covers the production machine
connection path, retained parent snapshots, patch delivery and machine isolation. The UI
run covers grouped live work, history paging and composer/keyboard/model/jump-to-latest
controls. Captures confirm actual message/tool content replacing the reported empty rows.
They are private local artifacts under `/tmp/ace-iphone-coherent-green-22-attachments`.

The final spacing build passed all three UI flows again in
`/tmp/ace-iphone-chat-final-24.xcresult`. Work disclosure and file-summary controls now
occupy a single 48-point row; the invisible scroll anchor no longer inherits 30 points of
list padding. Running indicators align with their text. These are layout checks, not FPS
or input-latency measurements. Final private captures are under
`/tmp/ace-iphone-chat-final-24-attachments`.

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
