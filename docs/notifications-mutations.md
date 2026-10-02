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
