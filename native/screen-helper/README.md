# macOS screen helper

Build with `./build.sh` on macOS 13+. Other hosts skip successfully. The output is `build/AceScreenHelper.app`, with stable bundle id `dev.ace.screen-helper` and a persisted signing choice. `build-test-window.sh` builds the isolated integration-test application.

The daemon owns the helper through `@ace/provider-kit/process`. Launch with `--endpoint unix:/absolute/path` pointing at the private Unix socket created by `@ace/screen`. Stdin and stdout carry bounded newline JSON commands and replies, negotiated with `hello`. V1 `--socket PATH` remains supported. The socket carries independently decodable JPEG packets. The helper has no network listener and never requests macOS permission automatically; it prompts only for an explicit `permissions.request`.

Read [the package documentation](../../packages/screen/README.md) for permissions, framing, approval and focus checks, client indicators, recordings, simulator control and integration tests. Design decisions are in [ADR 0011](../../docs/adr/0011-screen-and-computer-use.md).

## V2 identity and installation

`build.sh` produces `build/AceScreenHelper.app` (`dev.ace.screen-helper`) and a compatibility symlink at `build/ace-screen-helper`. It fingerprints sources before invoking the compiler or signing tools. Unchanged sources retain the executable, signature and cdhash. The first build persists an existing signing certificate's SHA-1 identity in `build/signing-identity` (override initially with `ACE_SCREEN_SIGN_IDENTITY`); when none exists it persists `-` for ad-hoc signing. Use a persistent local development certificate rather than generating certificates per build. Changing that choice is a deliberate clean build, not a daemon action.

Configure `ACE_SCREEN_HELPER` with the app or its executable. The daemon copies each verified version once under `<ACE_HOME>/screen-helper/<version>/AceScreenHelper.app`, where the version names both the executable and Info.plist hashes (a first-layout install directly under `screen-helper/` is reused while it matches). The copy is staged in a private directory and renamed into place in one step, so a version directory only ever exists complete; racing starts share the winner's copy, and startup never deletes a completed version. Copies abandoned mid-install are removed an hour later; bundles over 256 MiB or 4,096 files are refused. Subsequent startups verify hashes without copying or re-signing. A new app build with a different helper installs beside the old one, so running helpers are never rewritten and an upgrade never blocks capture. The adjacent manifest stays outside the sealed app. No action creates or executes temporary files.

At launch the helper re-executes itself once with responsibility disclaimed (`responsibility_spawnattrs_setdisclaim`), sharing stdio and the process group, so macOS asks about and remembers Screen Recording and Accessibility for "Ace Screen Helper" rather than for whichever app launched the daemon. `--inherit-responsibility` (set by the daemon from `ACE_SCREEN_HELPER_INHERIT_RESPONSIBILITY=1`) skips this for development. `permissions.request {permission}` shows macOS's prompt the first time and opens the matching Privacy & Security pane; it runs only when a person asks. `button.press {name}` presses a button of the captured window by accessible name (Simulator's Home, Rotate and Sleep/Wake), after focusing that window without activating its app. A captured window that is resized or rotated gets its stream reconfigured to the new size.

Release procedure: build an app, sign it with **Developer ID Application**, hardened runtime (`--options runtime`) and a secure timestamp, verify its signature, submit an archive with `xcrun notarytool submit --wait`, and staple the approved ticket with `xcrun stapler staple`. Publish hashes only after final signing/stapling. Do not distribute the ad-hoc development build as a notarized release. Follow [Apple's notarization documentation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution). Windows release helpers require Authenticode; their platform workstream owns that signing.

V2 accepts `--endpoint unix:/absolute/path`; v1's `--socket /absolute/path` also works. The daemon owns a 0700 IPC directory and 0600 socket. `hello` returns v2 capabilities without launching another process. Legacy envelopes retain string errors; v2 uses typed errors. UI refs retain their identity for the element's life in the helper. Changing targets or stopping capture retains identities, while actions reject refs outside the current approved target. Destroy notifications remove dead refs; confirmed application termination permits pruning. Live refs are never evicted. At capacity, discovery returns typed `busy` rather than reassigning refs. AX snapshots expire on notifications or at the next request after 250 ms. The command loop services at most sixteen queued run-loop sources per command, including destruction observers registered once per ref and target, without an idle refresh timer. Values from secure text fields are omitted. Traversal caps are depth 16, nodes 512, 56 KiB of node data and a 250 ms work budget checked between nodes. Each AX request has a 50 ms messaging timeout; replies indicate truncation. Ref storage caps at 4096 and never reassigns a live ref.

Mac-only `capture {enabled}` leases pixel capture independently of target selection; its acknowledgement includes the sequence floor for fresh screenshots. Semantic reads/actions need no capture lease. Releasing the last lease stops and removes the SCStream output and releases its stream/buffers; the approved configuration and encoder remain reusable in the idle host. Core Image initializes only on the first encoded frame. Window streams use the selected window filter, GPU sizing, damage metadata and requested minimum frame interval. Empty damage and idle samples skip JPEG encoding. Initial snapshots on an explicit capture lease are allowed. No polling or command process is used per action.

The owner's current rule permits static checks only. Runtime assertions, CPU/RSS measurements and all mutation cases **need run at merge**; do not execute the tests or benchmarks during feature work.

## Interaction timing

`measure_interaction` takes a live approved window session, optional `action` in
v2 `Input` format, `observeMs` from 1 through 10000, and `filmstrip`. Observation
needs Screen Recording; input keeps the existing Accessibility, target, secure
text and background focus checks. The separate desktop-independent window
stream uses the matched display's maximum refresh rate and queue depth 3, with
GPU sizing capped at 960 by 640. ProMotion's variable cadence and deliberate
low-rate animations can make display-interval gaps ambiguous.

Content update times come from `CMSampleBufferGetPresentationTimeStamp`.
Injection marks come from `CMClockGetTime(CMClockGetHostTimeClock())` immediately
before the first AX or process-event dispatch, so both are host monotonic time.
The baseline precedes dispatch; `updatesMs` excludes it. The TS analyzer owns
settling, hitch and confidence decisions. The helper returns observed timing,
load average, core count, and callback processing time as `captureOverheadPct`.
This overhead measures sampling and thumbnail work; it does not measure SCK's
GPU or WindowServer cost. Callback arrival times never replace presentation times.

The difference grid samples 96 by 64 RGB pixels with a noise threshold. Tiny
changes between samples may be missed. Point latency prefers a nearby region,
then falls back to the whole window with a note. Timing evidence caps at 2400
updates; only the baseline and up to 16 downsampled keyframe candidates are held.
Filmstrip timestamps are relative to input dispatch, or observation start without input.
The filmstrip is a timestamped two-column JPEG, with yellow damage outlines and
hitch markers, capped at 24 KiB to fit the helper's existing 64 KiB stdout limit.
Nothing is saved to disk by the native measurement path.

Fixture flags `--smoothness-smooth`, `--smoothness-stall` and
`--smoothness-latency` begin their behavior through the existing Click test
button. They animate at the display maximum, insert one 120 ms stall around
+400 ms, or delay the visual response by 180 ms. A non-gating busy-window cost
benchmark uses only that fixture and requires existing permissions:

```sh
sh native/screen-helper/build.sh
sh native/screen-helper/build-test-window.sh
ACE_SCREEN_INTEGRATION=1 bun run packages/screen/bench/interaction.ts
swift test --package-path native/screen-helper --filter MeasurementFramesTests
```

The benchmark skips without opt-in or grants. A missing capture baseline returns
an explicit error mentioning locked or unavailable capture rather than claiming
that the UI was smooth.

The measurement-only fixture stays in the background and exposes only its
pattern and AX button, avoiding activation and text-editor windows. Its display
link follows the window's display; a sequence-coded pattern preserves visible
changes when more than one fixture tick is coalesced.

The internal `maxWindowMs` allowance bounds each run to the remaining repeat
recording budget; omitted allowances default to ten seconds. If AX preparation
consumes the allowance, the helper rejects before dispatching input.
At capture origin plus that allowance, an independent watchdog requests SCK stop
outside the main actor, even while an AX call is pending. Evidence past that
cutoff is discarded and deadline clipping is reported as incomplete. Normal
cleanup awaits the same stop acknowledgement. A thrown stop failure terminates
the helper, so the daemon confirms process cleanup before clearing capture.
A stop that never acknowledges relies on the existing daemon command timeout
and supervised process cleanup, at most 15 to 25 seconds for measurement commands.
The watchdog cannot prove SCK has stopped until acknowledgement or process cleanup.
