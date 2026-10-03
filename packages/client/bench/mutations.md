# Mutation cases

Final revision status: not executed (tests run at merge). Each case names the public behavior test designed to detect it. The four review survivors are listed first. Earlier fix-round runs caught all 16 mutations and restored production code, before the owner prohibited further execution. That historical result does not verify the final revision. Runtime verification needs run at merge. The runner is retained for the merge-time verification workflow.

- result-type decoder bypassed: covered by "a correlated response of the wrong result type"; not executed (tests run at merge).
- daemon identity guard removed: covered by "a reconnect to a different daemon identity"; not executed (tests run at merge).
- incremental entity cap removed: covered by "incremental entity overflow"; not executed (tests run at merge).
- snapshot item-count cap removed: covered by "a snapshot exceeding the wire item budget"; not executed (tests run at merge).
- retry cap removed: covered by "retry ceilings double"; not executed (tests run at merge).
- resume cursor omitted: covered by "reconnect mid-stream"; not executed (tests run at merge).
- duplicate coverage resyncs: covered by "reconnect mid-stream"; not executed (tests run at merge).
- missing coverage ignored: covered by "a dropped frame"; not executed (tests run at merge).
- request deadline reports abort: covered by "a request deadline"; not executed (tests run at merge).
- abort reports timeout: covered by "abort cancels"; not executed (tests run at merge).
- first release unsubscribes: covered by "two views keep"; not executed (tests run at merge).
- MRU eviction replaces LRU: covered by "LRU retains"; not executed (tests run at merge).
- fatal auth accepts network retries: covered by "an auth rejection"; not executed (tests run at merge).
- restart drops pending replay: covered by "a persisted outbox"; not executed (tests run at merge).
- delta mutates prior selected item: covered by "only the changed item"; not executed (tests run at merge).
- send precedes durable write: covered by "a failed persistence write"; not executed (tests run at merge).

## Verifier follow-up cases

All cases below are **not executed (tests run at merge)**.

- Restore arrival-order prepending or replace the cursor from every response: `overlapping history pages applied out of order keep creation order and a stable cursor` checks A/B/C order, unique IDs and the retained null cursor.
- Send full oversized text in wire pages: `oversized text history is a bounded preview with lazy complete text reads` checks a small prefix, full lazy text, subsequent traffic and scoped health.
- Fetch/copy a whole legacy chunk before slicing: `one-byte output reads transfer only the selected byte from a legacy multi-megabyte chunk` checks exactly one transferred byte at the SQLite result boundary.
- Parse or rewrite the old multipart preview on every delta: `appending to a multipart text stream never reads the previous preview body` makes old-body access fail while checking the real stream's appended bytes.
- Retain consumed decoded output chunks: `a paused output consumer does not retain chunks it already consumed` checks collection through a WeakRef in a real daemon child with explicit GC.
- Construct a snapshot before choosing resume: `reconnecting resumes delivery even when the snapshot boundary cannot supply a view` disables that boundary and checks replayed text/cursor.
- Route an entity limit to the connection or stop other subscriptions: `incremental entity overflow fails the affected subscription while other threads stay live` now verifies a second thread receives later metadata.
- Normalize isolated surrogate halves before storing text: `text streams preserve surrogate pairs split across provider deltas` reads the exact pair through the public text generator.
- Reuse an old source ID after authoritative replacement: `authoritative text replacement invalidates an active detail read rather than mixing versions` checks a typed rejection and healthy later traffic.
- Mutate a prior selected source or leave its size unchanged: the oversized-text case checks immutable prior metadata, incremented live size and the persisted suffix read.

- Skip upgrading existing text sources: `upgrades existing oversized text and appended code units into bounded previews and lazy sources` checks restored data, bounded prefix and exact suffix bytes; not executed (tests run at merge).
