# iOS history cache, 2026-10-28

Opened older pages and expanded message text now use the phone's existing SQLite read cache.
The retention policy is seven days, subject to the shared 64 MiB storage budget. Settings →
Cached chats shows their bytes and clears them per machine or for all machines. The Clear
button remains enabled when cached content exists without any recent-thread rows.

The SDK validates each saved page's schema and thread revision before reuse. Only an actively
subscribed, confirmed thread can validate a saved page. A changed or unconfirmed thread fetches
the page again. Full text is identified by the daemon's immutable revision-bearing stream id
and byte extent. Editing text or appending to it changes that identity. This does not add
offline access to arbitrary older pages; startup still paints the existing unconfirmed tail.

A Settings clear invalidates pending history writes before dropping the SQLite records.
Reload from machine drops that thread's pages. Cache failures fall back to the daemon and do
not affect drafts, unsent messages or pairing. Generic cache writes trigger retention sweeps,
so browsing older pages alone cannot keep growing the cache without eviction.

Validation includes SDK reads through a simulated wire and real daemon pagination, row-store
retention/deletion, and bridge clear/reload checks. Cases cover relaunch without a page fetch,
changed revisions, seven-day expiry, corrupt records, cancellation, a response arriving after
clear, idle unleased threads, and UTF-16 text containing emoji. The simulator test build passes.
See ADR 0105 for the storage contract and conservative revision policy.

Final focused run: 62 tests across six files passed, including real-daemon long-thread reads.
The Duo Settings UI test also passed: reload, persistence across launch, and clear back to zero
cached chats. The initial UI run assumed an empty fixture cache and found five chats left by
previous tests; its setup now clears only the loopback fixture's cached chats first. Production
pairing and cached chats were not cleared. The first-time text read still yields chunks before
all content arrives; cached replay remains bounded and preserves surrogate-pair boundaries.

The final repository check passed formatting, protocol docs, lint, size, generated UI assets,
UI checks, dependency boundaries and type-checking. Dependency-cruiser warned that its parser
has not yet added TypeScript 7 support. The test stage reproduced the previously established
Codex `subagent.jsonl` status-timeline failure and fake-daemon agent-count failures in
`home-list.test.ts` and `long-thread.test.ts`. The broad run was stopped after those failures;
the full check and performance gate are not green. No physical iPhone was updated.
