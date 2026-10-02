# Notification mutation checks

Run on 2026-10-02 using `bun run test <test-file>`. Each mutation was applied to production code alone, produced a behavioral test failure, then was reverted. Repeated after moving active entity indexes to SQLite.

| Production mutation                                     | First failing behavior                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Remove done intents                                     | packages/notify/src/status.test.ts > alerts for whole-thread completion, failure and silence from core status                            |
| Notify before the coalescing deadline                   | packages/notify/src/status.test.ts > bursts coalesce at the first deadline with the final status and count                               |
| Disable presence suppression                            | packages/notify/src/delivery.test.ts > phone alerts are suppressed only by recent input on the same focused thread elsewhere             |
| Ignore quiet hours                                      | packages/notify/src/delivery.test.ts > overnight quiet hours use the configured timezone and end at the exclusive boundary               |
| Replace exponential backoff with a constant delay       | packages/notify/src/delivery.test.ts > delivery retries follow exponential backoff and stop after five attempts                          |
| Allow revoked device re-registration                    | packages/notify/src/delivery.test.ts > a revoked device loses queued jobs, presence and its address and cannot re-register after restart |
| Change the Web Push final-record delimiter              | packages/notify/src/webpush.test.ts > matches the complete RFC 8291 section 5 ciphertext test vector                                     |
| Use the wrong APNs device route                         | packages/notify/src/apns.test.ts > sends APNs alert and deep link over HTTP2 with a verifiable ES256 provider token                      |
| Permit a prior-turn retry during a later completed turn | packages/notify/src/delivery.test.ts > a retry from a previous completed turn cannot be delivered during a later completed turn          |

## Review follow-up

Each of these nine edits was applied alone on 2026-10-02, caused an assertion failure through the public API, and was reverted. The first seven are the review survivors. The raw-copy edit now targets the compact projection: its strict schema rejects leaked raw fields before IPC; the real-worker test detects the lost deep link as well as any leaked wire bytes.

| Production mutation             | Failing behavior                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Keep completion on resume       | packages/notify/src/review.test.ts > resumed work clears completion while retaining a later background completion                    |
| Retain archived intent          | packages/notify/src/review.test.ts > unarchiving before the deadline never resurrects a cancelled completion                         |
| Remove pending expiry           | packages/notify/src/review.test.ts > expired pending intents do not occupy the delivery batch ahead of a fresh alert                 |
| Constant APNs collapse          | packages/notify/src/apns.test.ts > sends APNs alert and deep link over HTTP2 with a verifiable ES256 provider token                  |
| Failed task as success          | packages/notify/src/review.test.ts > resumed work clears completion while retaining a later background completion                    |
| Copy raw interaction            | packages/notify/src/ipc.test.ts > worker messages omit unused giant identifiers and raw provider data while replay keeps progressing |
| Never rotate token              | packages/notify/src/apns.test.ts > sends APNs alert and deep link over HTTP2 with a verifiable ES256 provider token                  |
| Restore closed socket ownership | apps/daemon/src/notification-race.test.ts > disconnect during hello leaves no closed socket in notification delivery ownership       |
| Restore capacity deadlock       | packages/notify/src/review.test.ts > startup beyond pending capacity catches up before delivering and never sends stale completion   |

## Verifier follow-up after merging main

The owner-status survivor N10 from `/tmp/ace-orch/verify-23.md` is caught by `review.test.ts`, "a child question becomes the needs-you link only after its owner stops working". The test starts with the root approval eligible and the working child's question ineligible, then ends the child's turn while the root approval remains pending. Both devices must receive the actual child question id with no approval actions. Disabling the owner-index update query caused an assertion failure, receiving zero replacement notifications instead of two. The mutation was reverted and the same test passed.
