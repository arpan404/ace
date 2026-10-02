# Remote access verification

Run on 2026-10-02 with Node 26.8.1, Bun 1.4.0 and Vitest 5.0.3.

`bun run check` passes format, lint, file-size, TypeScript and the full test suite. The final run has 398 passing tests and four existing opt-in live-provider tests skipped. No provider prompts or recorder sessions were run.

The added behaviors use real HTTP/HTTPS/WebSocket listeners, temporary SQLite databases and real child processes. Time is injected for expiry and rate windows. Tests synchronize through process output, socket messages and close events, without sleeps or explicit wall-clock budgets.

## Mutation checks

Each change below was applied alone to production code. Its focused Vitest test failed with an assertion, then the production file was restored. No failure relied on a test timeout. All sixteen mutations were reverted.

| Mutation                            | Failing behavior                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| pairing reuse                       | carries the pin and one-time code only in the URL fragment and consumes the code once                           |
| pairing expiry                      | expires a pairing code at five minutes                                                                          |
| pairing rate limit                  | rate limits wrong codes and permits another attempt after the window                                            |
| plaintext token storage             | stores only a SHA-256 token hash and returns no token in device listings                                        |
| ticket reuse                        | consumes a socket ticket once and accepts it on a pinned WSS connection                                         |
| ticket expiry                       | expires a socket ticket at sixty seconds                                                                        |
| operate scope bypass                | lets a read device subscribe but refuses commands before they change the store                                  |
| live revocation omitted             | revokes a device immediately, closes all its sockets and rejects outstanding tickets and tokens                 |
| pin bypass                          | rejects a TLS fingerprint mismatch before redeeming the code                                                    |
| LAN exposure by default             | defaults to loopback only and requires explicit network exposure before pairing                                 |
| host credential on remote socket    | keeps the local token working while rejecting it and device tokens in remote hello                              |
| ticket identity bypass              | rejects a ticket used with another device's identity                                                            |
| admin scope bypass                  | lets a read device subscribe but refuses commands before they change the store                                  |
| wrong QR payload                    | starts in the foreground and exposes status, a redeemable QR URL, device listing and revocation through the CLI |
| revoked bearer accepted             | revokes a device immediately, closes all its sockets and rejects outstanding tickets and tokens                 |
| outstanding revoked ticket accepted | revokes a device immediately, closes all its sockets and rejects outstanding tickets and tokens                 |

Commands were `bun run test apps/daemon/src/remote.server.process.test.ts -t <behavior>` or, for the QR mutation, `bun run test apps/daemon/src/remote-cli.process.test.ts -t "starts in the foreground"`. The clean full suite was rerun after restoration.

## Review regression checks

Merged `origin/main` before changing the reviewed implementation. The following regressions were reproduced before fixing them:

- One read device obtained a 33rd pending ticket instead of HTTP 429. The new public HTTPS test fails against the old allocator, then passes with the per-device quota. Further HTTP/WebSocket tests exhaust a configured global cap, revoke a device and authenticate another immediately, and consume each issued ticket before testing the per-device rate window.
- Invalid public `store.devices.create` persisted an empty-name row and made the HTTP listing return 500. The new test first failed with that response, then passed after complete-record validation moved before insertion. Invalid scopes, creation timestamps and lifecycle timestamps also leave valid rows unchanged.
- A wildcard Tailscale binding passed the old advertised-address test. The strengthened test fails on a successful real TCP connection through the machine's external IPv4 address and redeems a pairing through the selected loopback interface as a positive control. Restoring the interface binding passes.
- A shared ticket pool across two daemon starts passed the old restart test. Using the paired device ID makes the old ticket incorrectly yield `welcome`, which now fails the assertion. A fresh ticket for that same device successfully authenticates after restart. Restoring per-server ticket ownership passes.

The initial provider discovery concurrency runs passed with ordinary OS temporary directories. The independent verifier later reproduced the missing-version failure with checkout-local `TMPDIR`: extensionless CommonJS stand-ins inherited an ESM package scope. The fixture now writes an explicit CommonJS package boundary. A new public discovery test first failed with a missing version under an ESM parent, then passed after the boundary fix. Controlled provider binaries only report version/authentication facts; no provider prompts run.

## Review mutation checks

All eight survivors from the review and five additional mutations were applied individually and restored in `finally` blocks. Each produced an assertion failure through the public HTTP, WebSocket, CLI or store API, without relying on a timeout. The full suite runs against restored production code.

| Mutation                                  | Failing behavior                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Remove 1 MiB client response cap          | A real HTTP endpoint's 2 MiB valid JSON response must be rejected                            |
| Remove 4 KiB request cap                  | A 100 KiB redemption must return 413 without consuming the valid code                        |
| Remove global ticket cap                  | Another device must receive 429 while all global slots are occupied                          |
| Ignore certificate validity               | A correctly pinned expired or not-yet-valid certificate must be rejected                     |
| Bind Tailscale to wildcard                | The actual LAN interface must refuse TCP connections                                         |
| Retain tickets across in-process restarts | Old ticket with correct paired ID must be unauthorized; fresh ticket must welcome            |
| Remove global pairing throttle            | The 101st request across distinct injected source addresses must receive 429                 |
| Pad one random byte to 32 bytes           | Credential must preserve all 32 supplied entropy bytes and authenticate with the supplied ID |
| Skip ticket reclamation on revocation     | Another device must authenticate immediately after capacity is released                      |
| Remove per-device pending quota           | The 33rd pending ticket must receive 429 while another device still authenticates            |
| Remove per-device issuance rate           | Repeatedly consuming tickets must not bypass the issuance rate window                        |
| Read client certificate clock twice       | One valid clock reading must govern the handshake even if a later reading jumps past expiry  |
| Insert before validating device creation  | Rejected creation must preserve usable HTTP and persistent device listings                   |

Focused commands use `bun run test apps/daemon/src/<file>.test.ts -t <behavior> --reporter=json --outputFile=<temporary-report>`. JSON reports verify actual failed assertions rather than counting process failures. Temporary mutation scripts and reports are removed before delivery. The sixteen original checks above remain recorded, making 29 applied production mutations in this PR.

## Ticket allocation benchmark

Run `bun run --filter @ace/daemon bench:remote`. Five fresh Node processes per version exercised real loopback HTTP requests, temporary SQLite and crypto with the same 314 devices, 100 warm-up status requests and fixed clock. Each process issued successive batches of 1,000, 3,000 and 6,000 tickets, retaining 10,000 in total. The comparison temporarily restored only the pre-review `remote-auth.ts` from merge commit `cdf19dd`, leaving the rest of the workload identical, then restored production code.

| Batch | Pending after batch | Previous scan median | Expiry heap median | Heap version per request |
| ----- | ------------------- | -------------------- | ------------------ | ------------------------ |
| 1,000 | 1,000               | 278.6 ms             | 110.3 ms           | 0.110 ms                 |
| 3,000 | 4,000               | 536.0 ms             | 256.0 ms           | 0.085 ms                 |
| 6,000 | 10,000              | 924.4 ms             | 507.4 ms           | 0.085 ms                 |

Median retained heap after explicit GC was 2.86 MiB for the scan and 3.20 MiB for the indexed heap plus per-device ownership/rate accounting. Updated batch ranges were 105–119, 242–257 and 476–621 ms. Shared-machine load produced wider baseline ranges of 112–2,318, 289–4,609 and 665–1,090 ms, so these measurements are informational, not a speed guarantee or test threshold.

Issuance and consumption use O(log N) heap work rather than O(N) retained-ticket scans. Expiry processes only due entries. Revocation visits only that device's pending set, capped at 32 by default, removing each heap entry in O(log N). Tickets, ownership keys and rate entries are bounded by the configured global limit, with no tombstones accumulating after consumption or revocation.

## Independent verification follow-up

The verifier confirmed every previous runtime fix and all eight original survivors, then identified two new mutation gaps. These are now guarded through public APIs:

- Issue four tickets at relative times 0, 10, 20 and 30 seconds. Consume the oldest at 30 seconds, then use the second at its exact 70-second expiry. It must be unauthorized, while the two later tickets still authenticate. A separate real HTTP/WebSocket test verifies two capacity slots become available without consuming the expired ticket first, and that all later and newly allocated tickets authenticate. Removing heap repair after deletion fails both tests, first with expired-ticket `welcome`, then with an unexpected 429. Restoring production code makes both pass.
- Inject a one-byte entropy source into the public Store. Device creation must throw before any row persists. Close and reopen the actual SQLite database, verify it remains empty, then create and authenticate a valid credential as a positive control. Removing the source-length check fails the throw assertion. Restoring validation makes the test pass.

Both mutations were applied individually and reverted in `finally` blocks. Combined with the preceding 29, this PR records 31 applied production mutations. No ticket allocator or credential runtime change was necessary in this round; the new tests close the coverage gaps in correct existing code. The committed benchmark and allocation complexity remain applicable.

A new discovery regression test creates a nested temporary directory below an explicit ESM package and runs an extensionless CommonJS fake CLI through public `discoverProviders`. It reproduced the missing-version assertion before the fixture fix. The fixture now supplies an explicit CommonJS boundary, so it works with OS-temp or checkout-local `TMPDIR` without changing provider discovery production behavior. This was a deterministic environment assumption, not machine-load flakiness.

`bun run check` passes both with ordinary temporary directories and with `TMPDIR` rooted inside this ESM checkout, without a neutral package override at the TMPDIR root. Each run has 398 passing tests and four existing opt-in skips. All 140 source files satisfy the size limit. CI was disabled by the repo owner for this round; no CI run, rerun or wait was requested.
