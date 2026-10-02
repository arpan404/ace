# Remote access verification

Run on 2026-10-02 with Node 26.8.1, Bun 1.4.0 and Vitest 5.0.3.

`bun run check` passes format, lint, file-size, TypeScript and the full test suite. The final run has 341 passing tests and four existing opt-in live-provider tests skipped. No provider prompts or recorder sessions were run.

The 24 added behaviors use real HTTP/HTTPS/WebSocket listeners, temporary SQLite databases and real child processes. Time is injected for expiry and rate windows. Tests synchronize through process output, socket messages and close events, without sleeps or explicit wall-clock budgets.

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

Commands were `bun run test apps/daemon/src/remote.server.test.ts -t <behavior>` or, for the QR mutation, `bun run test apps/daemon/src/remote-cli.test.ts -t "starts in the foreground"`. The clean full suite was rerun after restoration.
