# iOS transcript robustness implementation

Work in progress, 2026-10-30. Scope: the findings and acceptance workload in
[the robustness audit](../../research/ios-web-transcript-robustness.md).

## Required outcomes

1. Both cold and warm snapshots publish coherently, with explicit revision/completeness fences.
2. Held scroll updates are coalesced and byte bounded; overflow has an authoritative recovery path.
3. Authoritative deletion/regrouping differs from payload eviction. Distant extent uses bounded metadata.
4. A single native viewport controller owns semantic/pixel anchors, follow/read/jump state and layout changes.
5. Bounded per-thread sessions survive transient view recreation and history can reopen around its saved item.
6. Cached history is explicitly stale/read-only. Current-state reads, revocation, clear and reload retain their guarantees.
7. Layout/keyboard/accessibility behavior and observable scroll outcomes have behavioral acceptance coverage.
8. A renderer change is conditional on measured failure of these contracts, not a prerequisite or an automatic rewrite.

## Verification record

### Continuation on MacBook Pro Rijan

Source thread: `app://ace/t/01a18ca5-5396-740b-b5c5-b318680a5c15`.
The source checkout was `/Users/arpanbhandari/Code/ace-next` at
`f99b2de65908ce29f4d3d097f917d5d9b26465b3`. Its uncommitted tracked diff and
24 accompanying files were copied into this isolated worktree at `5a68c8f8e`.
The patch applied without conflicts. The archive SHA-256 was
`0f760b57e7a0355dfa74b5e4223e3b8a079f9b76e3c1ea5557159c5437b166c8`;
all packaged file hashes were verified before copying.

Unrelated audit output and the separate sidebar/GitHub stash were left on the
source Mac. No source files were modified there, and no commits were published.
The temporary transfer servers have exited.

The first local build reproduced a duplicate `applySessionRestore` declaration.
The duplicate was removed, keeping the implementation that uses the viewport's
tested restore calculation. Splitting scrolling and reading observers also
resolved the feed's Swift type-checking timeout. Subsequent builds caught four
out-of-order test arguments and a test pattern missing the new item-removal
metadata field; these were corrected.
The outstanding viewport acceptance includes held-top drift, capture after a
gesture, and layout invalidation on width/height changes.

Local bridge/cache run: 125 files passed, one failed; 753 tests passed, one
archive-download test timed out. Running `checkout-transfers.test.ts` alone
reproduced that timeout, with its other 12 tests passing. The cache suite's
16 cases pass. Formatting, protocol reference, lint, source size, generated
browser assets, UI values, dependency boundaries and incremental type checking
passed in the full repository check. The full test phase is not green.

`build-for-testing` succeeds for the arm64 iOS Simulator target with `-jobs 4`.
The generic multi-architecture build cannot link x86_64 because the generated
Markit simulator library is arm64; use `ARCHS=arm64` on this Mac. This is compile
verification only. No simulator or physical-device tests were run here.

The full repository check was stopped during tests after reproducing failures in
`packages/fake-daemon/src/long-thread.test.ts`, `client-protocol.test.ts` and
`home-list.test.ts`. It did not complete, and the performance phase did not run.
The separate bridge/cache run completed with the results above. Local logs are
`/tmp/ace-01a18ca5-check.log`, `/tmp/ace-01a18ca5-bridge-tests.log` and
`/tmp/ace-01a18ca5-native-build-arm64.log`. Markit web asset generation also
completed after dependencies and the submodule were restored.

### Source verification

Pending integration and native acceptance verification. Do not interpret earlier tests or the audit as completion of this work.

- Cache red test: `bun run test -- packages/client/src/kept-history.test.ts` initially failed both new behavior cases.
- Cache coverage: 16 SDK cases pass, including explicit offline cached reads, revision changes, cancellation, expiry, clear/reload/revocation races and daemon isolation.
- Bridge regression run: 126 files / 751 tests passed before final reconnect additions. The current native-transcript suite passes 12 tests, including edit-during-disconnect, reconnect without an offline read, absent geometry, and cross-task isolation.
- Independent Muse Spark cache review identified lease churn and absent-anchor reconnect loss; both were fixed. Rebuild transfers the existing lease, waits for confirmed subscription state, and falls back to the retained range when no visible anchor is available.
- TypeScript workspace and root incremental typechecks pass. Dependency boundaries pass, with the existing dependency-cruiser TypeScript 7 compatibility warning. Source-size and UI-value checks pass.
- Native builds caught a guard fallthrough and two new test syntax errors; those are corrected. Viewport integration build and native model/UI acceptance remain pending.
- Full repository check is not green: formatting includes an unrelated research document; protocol reference manifest is stale. Full tests are running and already expose unrelated fixture expectation failures plus missing generated Markit web assets. These files are outside this change.
