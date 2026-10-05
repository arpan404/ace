# Image attachment review follow-up (PR #119)

The owner's latest rule permits static checks only. No tests, probes, mutation
runs, benchmarks, flakiness runs or CI were executed for this revision. Every
runtime assertion below **needs run at merge**. Tests were written before their
corresponding production changes; their pre-fix failures are code deductions,
not observed executions.

## Review findings

| Finding                               | Pre-fix behavior / regression                                                                                                                                                                                                                                                       | Change                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native echoes and restart correlation | Real Claude/Pi envelopes contain images only in raw; OpenCode loses prompt files. A resume before any persisted echo has no hash mapping. `apps/daemon/src/engine/attachment-echo.process.test.ts` covers native translators, image-only inputs, raw-field preservation and resume. | Commit indexed thread/hash metadata with intent id before send; resolve native paths/URIs/base64 against that durable table. Keep unrelated raw fields. Group Claude image user envelopes; retain OpenCode prompt files and Pi text parts.                                   |
| UI transcript images disappear        | Existing renderers do not consume `item.attachments`.                                                                                                                                                                                                                               | UI changes are explicitly forbidden to Codex. PR description assigns metadata rendering, cancellation, cleanup and owning-connection resolution to the Claude web agent. Backend metadata and per-connection API are available. This UI finding remains open for that agent. |
| WSS revocation during a read          | Scope remains valid while thread permission is revoked. `apps/daemon/src/context.remote.process.test.ts` suspends storage authorization and revokes thread access.                                                                                                                  | The asynchronous access callback includes current `canReadThread`, before and after I/O.                                                                                                                                                                                     |
| Actor history materialization         | Cold unrelated message bodies are read by constructor enumeration. The resume regression injects an invalid unrelated SQLite body that is never requested.                                                                                                                          | No transcript scan or reconstructed actor map; one primary-key lookup per distinct echoed attachment.                                                                                                                                                                        |
| Stalled HTTP responses                | Eight paused authenticated consumers occupy all slots indefinitely. `apps/daemon/src/attachment-http-budget.process.test.ts` observes recovery using an injected deadline and a new HEAD request.                                                                                   | Absolute 30-second deadline covers storage, drains and response completion; close wakes waits and finally releases admission. Each completed wait detaches, avoiding retained prior chunks.                                                                                  |
| Original budget mismatch              | The default 256 KiB silently applies to originals despite the explicit-budget contract. `packages/client/src/attachment-budget.test.ts` guards rejection before network access.                                                                                                     | Originals without `maxBytes` throw `ClientError("limit")`.                                                                                                                                                                                                                   |

Additional static finding: the HTTP route detached the real ContextService method
from its receiver. `apps/daemon/src/attachment-range.process.test.ts` passes the
actual service instance, uploads over the public socket and fetches over HTTP;
the route now binds the service method. That test also checks a 1 MiB range on a
2 MiB original, so removing the independent range cap cannot pass via file length.

Adapter serialization tests now send the repository's real PNG/JPEG fixtures.
They validate native payload serialization, **not real provider acceptance**.
Relay preview tests decode dimensions instead of accepting arbitrary small bytes.
`packages/client/src/attachment-isolation.process.test.ts` keeps two real daemon
connections open and verifies content ownership in both directions.
`packages/context/src/preview-budget.process.test.ts` guards decoder admission
with distinct image formats and observable LRU regeneration through injected
renderer I/O. Projection/service test names describe explicit fallbacks.

No comment titled “Integration rehearsal: findings for this PR” was present in
issue comments or inline review comments at the time of this revision.

## Intended mutation kills

Each row is **not executed (tests run at merge)**. None is claimed caught or
surviving. Paths below identify existing or new behavior assertions.

| Mutation                                     | Intended assertion                                                                             | Status                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------- |
| Corrupt nonaligned chunk writes              | context/image-integrity.process.test.ts exact stored hash                                      | not executed (tests run at merge) |
| Trust filename MIME                          | same test misleading extension and MIME                                                        | not executed (tests run at merge) |
| Skip commit hash comparison                  | context/uploads.test.ts hash mismatch refuses commit                                           | not executed (tests run at merge) |
| Accept HEIC                                  | context/image-integrity.process.test.ts explicit unsupported result                            | not executed (tests run at merge) |
| Remove MIME filename extension               | context/service.process.test.ts exact PNG path bytes and suffix                                | not executed (tests run at merge) |
| Replace canonical MIME with wildcard         | client/attachments.process.test.ts outgoing image MIME                                         | not executed (tests run at merge) |
| Claude sends file reference                  | adapter-claude/session.process.test.ts native source content                                   | not executed (tests run at merge) |
| Codex sends text instead of localImage       | adapter-codex/session.process.test.ts native input items                                       | not executed (tests run at merge) |
| OpenCode sends file URL                      | adapter-opencode/v2-session.process.test.ts inline URI                                         | not executed (tests run at merge) |
| Pi drops image data                          | adapter-pi/session.process.test.ts native prompt images                                        | not executed (tests run at merge) |
| ACP drops native MIME                        | adapter-acp/session.process.test.ts image prompt                                               | not executed (tests run at merge) |
| Cursor drops images                          | adapter-cursor/host-output.process.test.ts SDK input                                           | not executed (tests run at merge) |
| Bypass HTTP bearer validation                | daemon/context.remote.process.test.ts unauthorized status                                      | not executed (tests run at merge) |
| Serve 304 before permission checks           | same test current permission change                                                            | not executed (tests run at merge) |
| Bypass relay thread scope                    | daemon/attachment-relay.process.test.ts wrong-thread refusal                                   | not executed (tests run at merge) |
| Preserve matched host path/raw               | client/attachments.process.test.ts and engine/attachment-echo.process.test.ts no path/original | not executed (tests run at merge) |
| Increase preview dimensions                  | daemon/context.remote.process.test.ts and attachment-relay.process.test.ts decoded dimensions  | not executed (tests run at merge) |
| Remove decoder concurrency cap               | context/preview-budget.process.test.ts third distinct decode gets busy                         | not executed (tests run at merge) |
| Remove cache eviction                        | same test oldest preview regenerates after nine images                                         | not executed (tests run at merge) |
| Remove 1 MiB range cap                       | daemon/attachment-range.process.test.ts oversized valid range refused                          | not executed (tests run at merge) |
| Use global daemon connection                 | client/attachment-isolation.process.test.ts owning connection returns each original            | not executed (tests run at merge) |
| Ignore mid-read thread revocation            | daemon/context.remote.process.test.ts suspended WSS read returns forbidden                     | not executed (tests run at merge) |
| Remove durable input metadata                | engine/attachment-echo.process.test.ts pre-echo restart keeps attachment                       | not executed (tests run at merge) |
| Enumerate transcript in actor constructor    | same test cold unrelated body does not prevent resume                                          | not executed (tests run at merge) |
| Drop image-only user envelopes               | same test Claude/Pi image-only items                                                           | not executed (tests run at merge) |
| Discard unrelated raw fields                 | same test retained unknown field remains                                                       | not executed (tests run at merge) |
| Drop OpenCode prompt files before projection | same test actual OpenCode translator echo metadata                                             | not executed (tests run at merge) |
| Remove response deadline or leak slots       | daemon/attachment-http-budget.process.test.ts post-deadline HEAD succeeds                      | not executed (tests run at merge) |
| Apply implicit original budget               | client/attachment-budget.test.ts explicit-budget error before request                          | not executed (tests run at merge) |
| Detach ContextService receiver               | daemon/attachment-range.process.test.ts direct service HTTP fetch                              | not executed (tests run at merge) |

## Performance evidence

Static bounds: actor attachment startup performs zero transcript-body reads;
lookup uses `(thread_id,sha256)` as a WITHOUT ROWID primary key and returns one
metadata record. An echo deduplicates hash lookups within its own native envelope.
HTTP reads are at most 64 KiB, ranges at most 1 MiB, eight response slots per
listener, each with a 30-second absolute deadline. Decoder concurrency is two,
preview dimensions 256×256, preview output 256 KiB, cache eight entries (2 MiB).
Completed response waits do not retain earlier chunks.

`apps/daemon/bench/attachments.ts` defines actor-open and indexed lookup
measurements at 100 / 10,000 / 100,000 cold items, cold preview decoding, cached
reads and authenticated HTTP original/preview throughput. It reports elapsed
milliseconds, CPU user/system time, RSS, heap and peak RSS. Numerical results and
runtime bounds **need run at merge**; benchmark execution is prohibited now.

## Static checks for this revision

`bun run fmt`, `bun run lint`, `bun run typecheck`, `bun run check:size`,
`bun run check:deps` and `bun run docs:protocol --check` passed. All 3,549 source
files are within 1,500 lines. Dependency-cruiser exits successfully with its
existing TypeScript 7 compiler compatibility warning, so its coverage is limited.
`origin/main` was already merged when this run started; the requested merge
returned “Already up to date.” No UI files changed. CI is disabled and was not
run, re-run or watched.
