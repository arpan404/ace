# iOS and web transcript robustness audit

Audited 2026-10-30 against current worktree, HEAD `f99b2de65908ce29f4d3d097f917d5d9b26465b3`, including uncommitted iOS changes. Source audit plus the focused standalone Swift replay documented below. No implementation changes, provider sessions or simulator runs during this audit. The comparative review was static; runtime risks remain unproven unless explicitly marked reproduced. Sources are this repository's implementation and its README, AGENTS.md, ADR 0056, 0062, 0074 and 0105. Runtime effects described as risks are not reproduced failures. Line references describe the worktree at audit time.

The shared data architecture is already substantially aligned. iOS uses the shared `JumpController` beside a leased live tail, with a 400-item/2 Mi UTF-16 window (`apps/ios/bridge/native-transcript.ts:26`, `:166-195`). Web uses measured virtualization with explicit scroll modes (`apps/web/src/features/thread/transcript/feed-view.tsx:160-197`, `use-feed-scroll.ts:170-214`). The largest parity gap is the native viewport controller and its lifetime, rather than a missing history data API.

## 1. High: the new extent ledger removes the bound on visited history

**Verified:** `TranscriptExtent` retains `heights`, `leading` and `trailing` dictionaries by row ID (`apps/ios/Sources/Models/TranscriptExtent.swift:11-16`). Paging moves evicted IDs into the leading/trailing dictionaries and removes them only on reentry; all measured heights persist until a replace (`:38-76`). Repeated traversal of new history therefore accumulates IDs and measurements proportional to visited history, despite the 400-item content bound. Web explicitly forgets measurements for absent keys once its threshold is exceeded (`apps/web/src/lib/virtual-cache.ts:17-30`), called by the feed at `apps/web/src/features/thread/transcript/feed-view.tsx:197`.

**Risk:** native memory grows through long browsing sessions. Moreover, retained heights have no width, text-size or disclosure revision. Only mounted rows report fresh measurements (`apps/ios/Sources/Views/ConversationFeed.swift:73-82`), so offscreen spacer totals can describe an earlier layout after rotation or text-size changes. The comment that evicted contents remain in disk cache (`TranscriptExtent.swift:5`) is stronger than the actual cache guarantee in finding 5.

**Recommendation:** retain bounded nearby measurements and use compact page/sequence segments for distant extent, with an explicit layout revision and invalidation policy. Decide whether distant history needs persistent scroll extent at all before retaining each visited ID. Preserve the reader's semantic anchor when estimates change.

**Missing behavior test:** traverse many disjoint windows, resize and change text size, then return across evicted pages. Assert bounded retained memory and that the visible message and pixel offset remain stable. Current extent tests check totals for small fixed arrays (`apps/ios/Tests/TranscriptExtentTests.swift:19-65`), not layout invalidation or retention bounds.

## 2. High: keep-place restoration depends on a surviving row with unchanged geometry

**Verified:** native capture stores only row ID and a `UnitPoint` calculated from the old viewport and row height; it skips capture when the row nearly equals available height. Restore makes one `scrollTo` call (`apps/ios/Sources/Views/TranscriptReadingAnchor.swift:8-20`). The captured fraction preserves position mathematically when the dimensions are unchanged. It is not a stored pixel offset, and there is no item fallback, successor fallback or postmeasurement correction. Web stores row key plus item identity and pixel top (`apps/web/src/features/thread/transcript/use-feed-scroll.ts:216-224`), locates by item when grouping changes (`:180-186`), and chooses a successor when the held row disappears (`:360-390`). It also compensates later row measurements (`:155-167`, `:190-204`).

**Risk:** regrouping, deletion, a page that replaces the whole resident range, or row remeasurement can leave the old native target missing or move it after the single restoration. Tall messages are especially sensitive. The end-settle helper corrects the live edge only; it does not settle a historical reading anchor (`apps/ios/Sources/Views/ConversationFeed.swift:204-210`, `:270-276`).

**Recommendation:** give the native viewport a semantic item anchor plus pixel displacement and a defined deletion successor. Treat restoration as a bounded layout transaction that finishes after new geometry arrives, cancellable by a gesture. Reuse the web controller's behavioral rules where possible, while keeping SwiftUI-specific I/O separate.

**Missing behavior test:** preserve a partially visible tall message through prepend, grouping changes, deletion of the anchor, and delayed markdown/media height changes. Assert the visible message and offset, not that paging occurred.

## 3. High: scroll-time patch holding has no size bound and can postpone every reading update

**Verified:** native sets `readingHeld` while scrolling, appends scoped patches, and flushes the array only when neither scrolling nor page holding is active (`apps/ios/Sources/Models/ClientModel.swift:309-350`). Page completion is signaled by `reading.settled` after the shared read finishes (`apps/ios/bridge/native-transcript.ts:150-164`). This is a useful atomic-publication improvement, but there is no count/byte limit or per-key replacement in the Swift queue. Web instead keeps a held range mounted (`apps/web/src/features/thread/transcript/feed-view.tsx:181-194`) and compensates structural changes and measurements separately (`use-feed-scroll.ts:360-390`).

**Risk:** a joined history window receiving streaming updates during sustained touch/deceleration can retain many obsolete patches and publish a large main-thread burst on idle. Page data that arrives during the fling is deliberately held until idle, so the additional spacer catch-up path does not guarantee rows fill a traversed blank area during that same fling. This is a scheduling risk, not proof that every fling fails.

**Recommendation:** coalesce held entity updates by scoped identity and revision, preserving reset/delete/append semantics. Bound queued bytes and define recovery via a fresh complete reading snapshot. Keep page atomicity but measure and budget idle publication independently of bridge frame size.

**Missing behavior test:** stream into a joined reader while holding a long drag, deliver several bridge frames and a page completion, then release. Assert bounded retained work, latest visible text, no stale resurrection, stable anchor and bounded publication time.

## 4. Medium: native reading state belongs to a transient view; web remembers a limited session position

**Verified:** native `reading`, `following`, `anchor` and `extent` are `ConversationFeed` state (`apps/ios/Sources/Views/ConversationFeed.swift:41-47`). Disappearance cancels reading and removes the callbacks (`:251`); the view task scrolls a loaded thread to its end (`:218-224`). `TranscriptReading.cancel` drops its reading model (`apps/ios/Sources/Models/TranscriptReading.swift:100-124`). `ThreadShelf` retains six live thread models, not these viewport/window objects (`apps/ios/Sources/Models/ThreadShelf.swift:7-25`). Web keeps session scroll memory for 32 entries, including measurements (`apps/web/src/features/thread/transcript/scroll-memory.ts:9-38`), consumed at `feed-view.tsx:148-151`.

**Limit of the comparison:** web memory is explicitly in-memory only and refuses restoration if the last key changed or the saved row vanished (`scroll-memory.ts:41-52`). It does not establish durable reading continuity across process restart or all live-tail changes. Daemon read cursors in ADR 0062 are read/unread state, not viewport position.

**Recommendation:** define a bounded per-machine/thread reading session outside view lifetime. Store semantic anchor, offset, follow mode and enough information to reopen the history window. Persist it only if relaunch continuity is a product requirement; cache contents alone cannot restore a viewport.

**Missing behavior test:** leave a historical page, open other threads, return, and repeat after layout recreation. Separately specify behavior when the tail advanced, the saved item was deleted, the shelf evicted the thread or the process restarted.

## 5. Medium: disk pages are revision-gated network accelerators, not offline resident backing

**Verified:** `itemsWindow` rejects an offline client before consulting history storage (`packages/client/src/client-core.ts:909-930`). Cached window/page acceptance requires matching `page.seq` (`:927`, `:997-999`); the current revision exists only when ready, subscribed, not syncing and not unconfirmed (`:1005-1009`). This implements ADR 0105's conservative policy. A new live event can invalidate an otherwise unchanged old page. It correctly avoids treating an old cached page as current across reconnect. This is shared SDK behavior, not uniquely an iOS defect.

**Risk:** iOS retained blank extents can outlive the ability to fetch their content during connectivity loss, cache expiry, clearing or revision changes. Rapidly streaming threads may get little page-cache reuse. “Contents stay in the SDK's disk cache” is therefore not a safe viewport invariant. Neither web nor iOS should claim arbitrary offline history on this evidence.

**Recommendation:** retain the current authority checks. Make unavailable historical space explicit with a retry state. If offline historical reading is required, introduce an explicitly stale read-only history representation and a history-specific revision contract, rather than weakening the thread-cursor validation. Audit reconnect resets of extent and anchor against the parent lifecycle audit.

**Missing behavior test:** visit and evict history, disconnect, fling into its retained space, reconnect with an edit/deletion and changed cursor, then clear cache during a read. Assert visible stale/syncing/error semantics, no silent blank viewport, correct replacement and no stale cache refill.

## 6. Medium: keyboard handling does not cover general layout invalidation

**Verified:** native keyboard lift uses only vertical overlap, `max(0, feedBottom - end.minY)` (`apps/ios/Sources/Views/ConversationFeed.swift:225-238`). General geometry handling stores metrics, while explicit room corrections are driven by keyboard and composer changes (`:160-179`, `:242-249`, `:263-276`). The extent ledger has no width revision. Web explicitly observes viewport width, height and content clearance and maintains following on changes (`apps/web/src/features/thread/transcript/scroll.ts:34-71`), in addition to the row compensation in finding 2.

**Risk:** iPad floating keyboards can reserve vertical space without horizontal intersection; rotation, split width and text-size changes can invalidate lazy measurements while reading away from live. Exact observed movement requires device/layout tests. Bounded end corrections are a practical improvement, but do not prove general resize continuity, and are disabled with VoiceOver (`ConversationFeed.swift:274`).

**Recommendation:** model viewport bounds, keyboard intersection, composer clearance and layout revision together. Route their effects through the same follow/hold transaction rules. Preserve the deliberate avoidance of a standing `ScrollPosition` target until the accessibility regression documented at `ConversationFeed.swift:24-27` has a replacement test.

**Missing behavior test:** rotate and resize split view at live and in history, change Dynamic Type, show/dismiss a floating keyboard beside the reading column, and repeat with VoiceOver. Assert visible anchor or live-end clearance and gesture responsiveness.

## Order of work and verification

First bound extent and queued patches. Next introduce an explicit native viewport transaction controller with semantic anchors, deletion fallback and layout revisions. Then move reading-session ownership outside transient view lifetime. Treat offline history as a separate product/data contract, preserving current cache revision checks.

The new `HistoryPagingUITests` proves older/follow counters change and reaching live does not send `live` (`apps/ios/UITests/HistoryPagingUITests.swift:7-24`). It does not assert which messages remain visible, their offsets, blank coverage or latency. Keep that smoke test, but require the behavioral cases above before calling the scrolling robust. ADR 0074 still records real-device smoothness as an open gate; web's ADR budgets and implementation are useful reference points, not proof of native performance or proof that web has no defects.

## Parent verification: canonical deletion leaves phantom extent

Ran the production `TranscriptExtent.swift` with a standalone Swift harness:

```sh
swiftc -parse-as-library apps/ios/Sources/Models/TranscriptExtent.swift /tmp/ace-ios-audit-extent.swift -o /tmp/ace-ios-audit-extent
/tmp/ace-ios-audit-extent
```

Inputs: start with `deleted-answer` and `remaining-answer`, measured at 120 and 80 points. Update the resident order to only `remaining-answer`, with the current paging direction `.newer`. A second case removes the sole 120-point row.

Observed output:

```text
Canonical leading deletion retains phantom space: 120.0 points; expected 0
Removing the final row retains phantom space: 120.0 points; expected 0
```

This reproduces a limitation of the extent interface, not a full end-to-end daemon deletion. `TranscriptExtent.update` receives only IDs and direction; it cannot know whether a missing edge row was evicted, deleted, or regrouped. It stores missing edge rows as virtual space (`TranscriptExtent.swift:55-65`). `ConversationFeed.updateExtent` likewise supplies IDs and last reading operation, without a change reason (`ConversationFeed.swift:305-310`). The appropriate fix is an explicit change model separating eviction from authoritative deletion/regrouping, with stable item/sequence identity and a defined anchor successor. Inferring canonical deletion from list edges is insufficient.

## Parent verification: snapshot publication is not a complete transaction contract

The new staging path begins only on `thread.reset` (`apps/ios/Sources/Models/ClientModel.swift:429-435`). Whole-thread passes with an existing native ledger deliberately skip that reset (`apps/ios/bridge/patches.ts:75-84`). Their diff patches can therefore mutate the displayed model over multiple acknowledged bridge frames without entering staging. `FrameBatch` offers timing-based coalescing, not a snapshot revision transaction. In addition, `thread.ready` parses a count but the native publication handler ignores it (`apps/ios/Sources/Models/ClientModel.swift:481-490`).

**Classification:** verified protocol/control-flow gap; a partial-refresh visual failure was not reproduced during this audit. Preserve the last coherent display using an explicit snapshot begin/commit revision for both warm diffs and cold resets. Define completeness, rejection/retry, cancellation and bounded staging, instead of treating an arbitrary ready patch as proof of coherent content. Continue publishing canonical status/freshness promptly; visual snapshot retention must not imply that cached Done is authoritative.

## Recommended implementation order

1. **Correctness and bounded work.** Fix deletion-versus-eviction semantics; coalesce and byte-bound held reading patches; introduce explicit snapshot commit semantics for both warm and cold refreshes. Add failing behavior cases before changing these paths.
2. **One native viewport controller.** It owns reading/following/jump mode, semantic anchor plus pixel displacement, loaded range, layout revision, and publication/correction intent. SwiftUI supplies geometry and gestures. Keep the shared SDK, history controller, status derivation and outbox as their existing owners. Do not send every frame's geometry across JavaScriptCore or duplicate canonical rules in Swift.
3. **A durable, bounded reading session.** Keep per-thread anchor/range state above transient navigation views. Compact distant measured space into sequence/page segments and retain only nearby detailed sizes. Key measurements by layout revision: width, Dynamic Type, density and disclosure/content revision. Make unavailable cached space show an explicit loading/error state.
4. **Cache semantics.** Keep current revision and revocation checks. If old pages need useful reuse while new turns stream, add a narrower historical-page/turn revision contract. Explicitly stale, read-only offline history needs its own product and security contract. Current disk caching does not guarantee that all unloaded space can be immediately rehydrated.
5. **Renderer decision from evidence.** First test the controller with the existing renderer. If native measurement and anchor control remain insufficient, prototype a `UICollectionView` adapter with stable IDs and SwiftUI message rows using `UIHostingConfiguration`. Apple documents [diffable collection updates](https://developer.apple.com/documentation/uikit/updating-collection-views-using-diffable-data-sources) and [SwiftUI content in UIKit cells](https://developer.apple.com/videos/play/wwdc2022/10072/). These capabilities are not a guarantee of scroll stability; the same behavioral acceptance suite must evaluate both adapters.

## Acceptance evidence still needed

The recent `HistoryPagingUITests.swift:15-24` checks paging/follow counters and that the transcript exists. It does not measure pixel anchor drift, scroll extent, initial/final item visibility, or blank content frames. Existing passing counts should not be presented as proof of those properties.

Add a single deterministic parity workload for web and iOS: long variable-height messages; portrait images; delayed Markdown/media sizing; streaming while the reader holds a drag; prepend/evict/rehydrate; anchor deletion and regrouping; disconnect during page/snapshot publication; return after navigation; rotation, Dynamic Type, floating keyboard and accessibility interaction. Observe semantic item identity, pixel displacement, resident/queued bytes, cache/network reads and main-thread publication time. Use the existing ADR 0074/performance budgets as the starting gate, and explicitly test a visible anchor within two points after idle updates. Growth from newly discovered history is legitimate; visiting already measured history must not silently discard content or collapse its extent.

This is a transcript-centered audit, not a claim that pairing, files, devices, notifications or every iOS feature has been exhaustively reviewed. App-lock/system authentication is also distinct from a blank transcript; diagnostics should distinguish those states without bypassing authentication.
