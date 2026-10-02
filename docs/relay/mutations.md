# Relay mutation verification

On 2026-10-02, each change below was applied alone to production code. A focused Vitest run failed for the named behaviour, then the exact original file was restored before the next mutation. No mutation remains in the branch.

| Mutation                            | Production file                         | Failing behaviour                                                                            |
| ----------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| HKDF output order                   | `packages/secure-channel/src/crypto.ts` | official Noise XX vectors matches every cacophony handshake and bidirectional transport byte |
| Nonce endianness                    | `packages/secure-channel/src/cipher.ts` | official Noise XX vectors matches every cacophony handshake and bidirectional transport byte |
| Pinned identity bypass              | `packages/secure-channel/src/noise.ts`  | aborts before completing a handshake with the wrong pinned host fingerprint                  |
| Ciphertext authentication bypass    | `packages/secure-channel/src/cipher.ts` | rejects tampered, replayed and reordered ciphertext without advancing the receive nonce      |
| Transport nonce reuse               | `packages/secure-channel/src/cipher.ts` | rejects tampered, replayed and reordered ciphertext without advancing the receive nonce      |
| Noise size limit bypass             | `packages/secure-channel/src/cipher.ts` | accepts maximum Noise transport size and rejects larger messages                             |
| Rekey keeps the old key             | `packages/secure-channel/src/cipher.ts` | coordinated directional rekeys keep the nonce and replace the old key                        |
| Relay frame-size bypass             | `apps/relay/src/server.ts`              | oversized binary frames and text frames are closed before forwarding                         |
| IP connection limit bypass          | `apps/relay/src/limits.ts`              | per-IP concurrent connection limits reject upgrades and release slots on close               |
| Message-rate bypass                 | `apps/relay/src/limits.ts`              | message rate limits apply across sockets from one IP and tokens recover with time            |
| Relay backpressure disabled         | `apps/relay/src/server.ts`              | 10 MB crosses the relay under backpressure with bounded buffers and reverse traffic          |
| Control-frame rate bypass           | `apps/relay/src/server.ts`              | WebSocket control frames cannot bypass per-IP message rate limits                            |
| Ticket consumption bypass           | `apps/relay/src/server.ts`              | stream tickets are single-use and expire before an unauthenticated join can consume them     |
| Host id trusts an asserted identity | `apps/relay/src/server.ts`              | registration proves possession of the static key and ignores a claimed host id               |
| Rekey resets the nonce              | `packages/secure-channel/src/cipher.ts` | coordinated directional rekeys keep the nonce and replace the old key                        |

Focused runs used `bun run test <test file> -t <behaviour pattern> --reporter=json`. The final unmutated repository is checked with `bun run check`. These are hand-applied defects, not claims of exhaustive mutation coverage.

## Review follow-up verification

After the availability fixes, the following eleven production mutations were applied individually on the final implementation. Each focused public-API test failed with an assertion or rejected promise, rather than relying on a timeout. Exact source bytes were restored after every run and verified before the unmutated suite passed again.

| Review id / mutation                           | Failing behavior                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| M11: remove reserved-nonce exhaustion          | Last permitted nonce works once; the next encrypt/decrypt must throw permanently               |
| M26: allow premature client frames             | Unpaired data was forwarded instead of closing with 1008                                       |
| M29: allow short non-final encrypted fragments | Invalid fragmentation resolved as a valid pong instead of rejecting                            |
| M30: bypass the incoming daemon schema         | Invalid daemon message resolved instead of rejecting                                           |
| M31: remove the host admission cap             | An excess client connected instead of being rejected while authorized channels remained usable |
| M32: refuse a newer proven registration        | Fresh proof failed instead of replacing a paused stale owner                                   |
| M15: bypass binary token throttling            | Registration arrived before the required refill                                                |
| M24: bypass control-frame throttling           | Pong arrived before the shared IP budget refilled                                              |
| R1: disable inactive LRU eviction              | A new IP was refused while an inactive entry was available                                     |
| R2: key IPv6 quotas by full address            | Another address in the same `/64` bypassed its connection quota                                |
| R3: disable the device-authorization deadline  | An unverified hello could still send after expiry                                              |

M32 from the original review changed duplicate rejection into replacement. Replacement is now required behavior, so the mutation tested here removes replacement. M22 remains equivalent: deleting the endpoint's redundant frame-size check cannot admit a frame larger than `ws.maxPayload`. Configured relay limits and Noise's own size limit have independent failing behavior tests; an equivalent mutation has no observable defect to detect.

Focused runs use `bun run test <file> -t <behavior> --reporter=json --outputFile=<temporary file>`. The 15 original mutations above are historical implementation evidence; these eleven runs verify the revised behavior.
