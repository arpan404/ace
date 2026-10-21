# iPhone checkpoint — 2026-10-20

Branch: `ace/ios-feature-parity`. Work is paused at the owner's request so the remaining fixes can be handled later. This checkpoint preserves the native feature work and current chat regression fixes; it does not claim complete browser parity or release readiness.

## Saved work

- Pinned connections to self-signed paired daemons, including Tailscale.
- Native navigation, projects and durable create/clone forms, conversation search, provider accounts, skills/plugins and machine tools.
- Native device and Mac screen channels and viewing/control surfaces.
- Composer, Markdown, conversation loading and bounded live-cache improvements.
- Replace the chat collection-backed list with a lazy scroll view and edge scrolling for the reported send-time crash.
- Share the browser's bounded history window/controller with native inline history, preserving the subscribed live tail.
- Keep live tool groups and progress narration inside the collapsed Working disclosure.
- Preserve the latest, still-unverified reading-anchor and JavaScriptCore test-harness corrections.

## Validation at pause

All app/runtime tests in this work were run on the connected physical iPhone 12 Pro. No new simulator or host-side test run was started for this checkpoint.

- Latest signed `build-for-testing`: passed (`/tmp/ace-iphone-regression-build32.log`).
- Six repeated sends with incoming row updates, cleared drafts and reachable composer: passed in `/tmp/ace-iphone-regression-30.xcresult`. This predates the latest anchor changes.
- Collapsed Working hides tools/narration; expanding and collapsing reveals/hides them: passed in `/tmp/ace-iphone-regression-31.xcresult`. The real paired conversation's collapsed-work check also passed.
- Seven connected-phone transport, real inbox/conversation and historical-service tests passed in run 31, including ordered inline pages while the live tail stays bounded and subscribed.
- Run 31 as a whole failed: four new history bridge tests failed during JavaScriptCore initialization because the harness lacked URL parsing. The harness now uses the native parser and fails fast, but those corrections have not been rerun on the phone.
- History position is unresolved. Run 30 demonstrated a 1,273-point reading-anchor jump. Run 31 loaded older content but missed the transient paging indicator before reaching the anchor assertion. The latest code captures row geometry before replacement, accounts for viewport insets, and avoids a loading placeholder for a hold; it has built but has not been retested.
- Root TypeScript check, dependency boundaries, size and UI-value guards passed. Dependency-cruiser warned about TypeScript 7 support. Lint passed after the test entry-point import correction. The final root formatting check passed after formatting the history scenarios.
- Complete `bun run check` was not run because it includes host-side Vitest tests, contrary to the owner's physical-phone-only instruction. The previously reported stale protocol manifest remains outside this checkpoint's changes.

The xcresult bundles and phone screenshots are private local artifacts under `/tmp`; they are not committed.

## Resume first

1. Run the corrected history bridge suite and PatchPump suite on the connected phone. The shared test bundle now imports the history scenarios, so both harnesses install the native URL parser.
2. Rerun inline history anchor preservation over at least two older pages and Jump to latest. Inspect the screenshot and accessibility geometry, and make paging observation deterministic if needed.
3. Rerun repeated sends and the Working disclosure test after any scroll changes. Keep tool rows inside Working.
4. Rerun the paired-machine history/composer flows and appropriate static checks. Preserve the physical-phone-only test constraint unless the owner changes it.

## Related open issues checked on GitHub

- [#560 — native SwiftUI client on shared JavaScriptCore client](https://github.com/arpan404/ace/issues/560): parent scope, including performance and notification gates; remains open.
- [#1128 — relay, browser audio and device view](https://github.com/arpan404/ace/issues/1128): this branch implements native device viewing, but relay/audio and remaining interaction/performance work still need review; do not close the umbrella issue.
- [#1166 — open files linked outside the project](https://github.com/arpan404/ace/issues/1166): pending native authenticated linked-file opening and physical-phone verification.
- [#1168 — bind scheduled Stop to its original thread visit](https://github.com/arpan404/ace/issues/1168): pending navigation/Stop race fix; separate from this checkpoint's scrolling work.
- [#1186 — iPad live-view warning attribution and nested frame](https://github.com/arpan404/ace/issues/1186): related device-view issue primarily in the shared/web capture path.
- [#1187 — hardware-decoding preference and diagnostics](https://github.com/arpan404/ace/issues/1187): related device-view performance/observability work; the existing native H.264 decoder does not close this shared/web issue.

No issue is closed by this checkpoint.
