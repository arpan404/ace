# 0096: One native host contract for the phone apps

Date: 2026-10-22. Status: accepted. Amends [ADR 0074](0074-native-ios-client.md) and
[ADR 0073](0073-native-mobile-clients.md).

## Context

The owner set the mobile direction on 2026-10-22: use native code wherever it makes the phone
faster, mirror it on Android, and keep one JS contract and all logic shared so it is testable.

Before this ADR the iPhone bridge reached Swift through an untyped `aceHost` global. Its shape
lived in three places: `bridge/host.ts` and two hand-made test hosts (`test-host.ts`,
`test-native.ts`), plus five more hand-built hosts in individual tests and in the Swift bridge
tests. Async operations were bare strings with JSON input. Large text (outbox records, read
snapshots, the 8 MiB reads cache) travelled as a JSON string inside JSON, so the script escaped
it and Swift unescaped it. Failures answered "Host operation failed" except for pinned HTTP,
whose refusal reasons the script matched by message. The pump base64-encoded every patch
natively only to learn its UTF-8 size. Nothing checked that an app and a bundle agreed.

## Decision

`@ace/native-host` (`packages/native-host`) is the only door between shared mobile logic and the
platform. It is a package rather than part of `@ace/client` because the web and desktop never
load it, and `@ace/client` stays on standard Web APIs plus the options it already injects. It is
not in `@ace/protocol`, which stays schema-only. Both phone bridges import it.

It holds:

- `contract.ts`: the `NativeHost` interface (`version`, `capabilities` and the functions below),
  `HostOperations` (each async operation's JSON `input`, unescaped `body` and text answer),
  `HostErrorCode`, and `HostEntries` (what the bundle installs for native code to call:
  `aceStart`, `aceAction`, `aceAck`, `aceSocket`, `aceAccess`).
- `connect.ts`: `connectHost` refuses, at load and by name, a host that is missing, older than
  `HOST_CONTRACT_VERSION`, lacks a required function, or lists a capability it doesn't implement.
  `requester` types every async operation and rejects with `HostCallError` (`code`, `operation`;
  `message` is the code, which the pairing code matches). `hostScheduler` gives the SDK its
  scheduler.
- `web-platform.ts`: `installWebPlatform` adds only the Web APIs the engine lacks (TextEncoder,
  TextDecoder, URL, AbortController, queueMicrotask, btoa/atob, crypto, and DecompressionStream
  when the host has `inflate`), each backed by the host.
- `node.ts` (`@ace/native-host/node`): `createNodeHost`, the contract on Node with injectable
  clock, ids and entropy, recorded frames and sockets, and handlers per operation. Every bridge
  test runs on it, so the shared logic is tested as JavaScriptCore runs it.

### Capabilities (version 1)

| Group                  | Members                                                                                | Notes                                                       |
| ---------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Clock, ids, entropy    | `now`, `uuid`, `random`, `randomBytes(n)`                                              | `randomBytes` returns a `Uint8Array`, at most 64 KiB        |
| Scheduling             | `timer(id, delay, cb)`, `cancelTimer(id)`                                              | callbacks run on the script's thread                        |
| Text                   | `encode`, `decode(bytes, encoding, fatal)`, `utf8Length`, `previewHead`, `previewTail` | previews cut at grapheme boundaries; a cut head ends in "…" |
| Bytes                  | `latin1Base64(text, decode)`, `inflate(bytes, format)` (optional)                      | zlib, 16 MiB ceiling, gzip CRC checked                      |
| URL                    | `parseURL`                                                                             | absolute URLs only                                          |
| Async operations       | `call(operation, input, body, done)`                                                   | see below                                                   |
| Outbound               | `emit(frame)`, `socket(id, action, value)`                                             | frame: JSON array, at most 32 patches and 32 KiB UTF-8      |
| Diagnostics (optional) | `tracing`, `trace(name, ms, bytes)`                                                    | totals with native spans (`HostTrace.swift`)                |

Async operations: `storage.load/save`, `storage.host.load/save`, `storage.records`,
`storage.write`, `storage.reads.load/save`, `inbox.checkpoint`, `snapshot.get/set/clear`,
`secret.get/set/delete`, `directory.load/save`, `http`, `credential` (debug fixture only),
`attachment.chunk`, `download.open/append/finish/discard` (files saved to the device a chunk
at a time), `access.result`. Error codes: `unsupported`, `storage`, `identity`,
`invalid`, `pin`, `redirect`, `offline`, `limit`, `failed`.

Bytes cross without copies where the engine allows: a `Uint8Array` argument is read by pointer
for the length of the call (`NativeBytes.withBytes`); a returned one is made once natively. Large
text for an operation travels as `body`, untouched. Versioning: additive members are optional
capabilities listed in `capabilities`; anything else raises `HOST_CONTRACT_VERSION`.

Native code holds no business logic: no status rules, grouping, protocol decisions or display
shaping beyond grapheme-safe cuts. Swift implements the contract in `HostContract.swift` (the
stateless functions, which the Swift bridge tests install too) and `NativeHost.swift` (timers,
operations, frames, sockets).

## What moved native, measured

Method: Release build on the iPhone Air simulator (iOS 26), paired through the app's real
pairing flow with the development daemon (`~/.ace/dev`, its real threads), launched with
`-ace-host-trace`. One scripted run: cold launch, inbox, open two threads, three history swipes
in each, back. Totals come from `HostTrace` (native spans) and the script's own spans. Two
baseline runs on `cab46f601` and three after; the daemon's data is live, so runs vary.

| Work                                              | Before              | After        | Change                                                                                                                           |
| ------------------------------------------------- | ------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Decoding patch frames on the main thread (412 KB) | 36.5 / 39.5 ms      | 0 ms         | moved to a serial `ace.client.frames` queue (37.6 / 39.8 ms there); the script and the UI wait on neither                        |
| Pump serialize, script thread                     | 4.0 / 5.7 ms        | 4.8 / 2.6 ms | `utf8Length` instead of base64 per patch (native 0.9–2.1 ms → 0.2 ms); the frame is the patches' own JSON, not stringified twice |
| Pump emit, script thread                          | 1.9 / 1.9 ms        | 1.4 / 1.5 ms | unchanged (decoding inside `emit` was tried first: 36 ms on the script thread, rejected)                                         |
| Snapshot write, 300 KiB, Swift decode             | 2.66 ms             | 0.001 ms     | body unescaped; the script side drops from 0.25 to 0.05 ms (Mac, JIT off)                                                        |
| Binary socket message to the script               | base64 out and back | bytes        | 0.6 ms per MiB and a third less memory                                                                                           |
| Script time (all runs, replies, timers, sockets)  | 264 / 299 ms        | 300 / 306 ms | unchanged within noise: it is logic                                                                                              |

Patch hand-off as structured data instead of JSON was measured and rejected: converting a 32-patch,
22 KB frame with `JSValue.toArray` costs the script's thread 0.25 ms and cannot leave it, against
0.017 ms for `JSON.stringify` (native in JavaScriptCore, JIT or not) with the parse on the frames
queue. A binary format would need an encoder in script, slower still without a JIT.

## Streaming text crosses as edits

Each text delta re-sent its whole item, up to 8 KiB, about 20 times a second on the fixture.
Patches now have a delta form, `thread.item.text`: the row's other fields whole, its text empty,
and an edit `{base, cut, append}` meaning "native's text is `base` UTF-8 bytes; drop `cut` bytes
from the front, then add `append`". The front drop covers the sliding 8,192-unit window of a long
answer. JavaScript decides the edit (`bridge/text-edit.ts`) against the text the native ledger
records native confirmed for items still streaming; without a confirmed base, or when an edit
would be most of the text, the row goes whole.

Guarantees stay the pump's: one acknowledged frame in flight, keys and readers retained until
confirmed, ordering and identities unchanged. `ClientModel` checks every edit in a frame against
the row it shows before applying anything (a length mismatch or a cut inside a character turns
the whole frame down, unapplied); the pump then forgets that ledger entry, so its retry goes
whole. An edit for another thread or an older generation is dropped like its whole row would be.

Measured on the fixture's streaming thread (Debug build, which `--spike` needs; 30 s, 584 deltas;
main-thread busy from a 10 s `sample` of the app):

|                                 | Before (two runs)      | After                        |
| ------------------------------- | ---------------------- | ---------------------------- |
| Bytes across the bridge         | 3,769 KB / 3,769 KB    | 367 KB / 372 KB (−90%)       |
| Main thread: edit check + apply | 32.0 / 32.2 ms         | 13 + 27–30 ms                |
| Main thread busy (10 s sample)  | 1,953 / 1,956 of 7,620 | 1,664 / 1,922 of 7,230–7,640 |
| Frame decode, frames queue      | 51.8 / 53.6 ms         | 51.1–54.2 ms                 |
| Script: pump serialize          | 11.0 / 12.0 ms         | 19.3 / 20.4 ms               |
| Process CPU per 30 s            | 9.06 / 9.18 s          | 8.52 / 8.83 s                |

The bytes fall by nine tenths; main-thread time is unchanged within noise because rendering the
re-laid-out text dominates it (about a quarter of the main thread while streaming), not the
bridge. An edit counted in UTF-16 first cost the main thread 118 ms for the same run, since Swift
transcodes to count UTF-16; counting UTF-8 bytes brought it to 13 ms.

Everything the profile shows as script time is logic: the SDK's socket handling, replay and
snapshots (`js.socket`, `js.reply`), and the bridge's shaping of rows (`pump.read`, about 30 ms of
the run). Status, grouping and protocol decisions stay there by rule.
Hashing and AEAD have no caller on the phone today: picked files are hashed in Swift, pins are
checked in Swift, and the iPhone connects directly over pinned TLS, so `@ace/secure-channel` is
never loaded. If the relay reaches the phone, `sha256`, `x25519`, `hkdf` and ChaCha20-Poly1305
become optional capabilities (CryptoKit on iOS, Tink or the platform providers on Android) used
by `@ace/secure-channel` when present.

## Android checklist

A Kotlin host implements the same contract; nothing else changes in the shared code.

1. Install `aceHost` before the bundle runs, with `version = 1` and `capabilities` (at least
   `inflate`).
2. Run every callback (timers, operation replies, socket events, `aceAck`) on the JS engine's own
   thread, never concurrently with it.
3. `now`, `uuid` (lowercase), `random` in [0, 1), `randomBytes` from `SecureRandom` as a
   `Uint8Array`, refusing more than 65,536.
4. `encode`/`decode` UTF-8 and UTF-16LE, `fatal` throwing on invalid input; `utf8Length`
   counting ill-formed UTF-16 as U+FFFD; `previewHead`/`previewTail` on grapheme boundaries
   (`BreakIterator`), a cut head ending in "…", unpaired surrogates repaired.
5. `latin1Base64` both ways ("" for invalid input); `inflate` with `java.util.zip.Inflater`
   (gzip, deflate, deflate-raw), refusing output over 16 MiB and trailing bytes.
6. `parseURL` returning the eight parts as JSON, or "" for anything not absolute.
7. Typed arrays crossing by pointer: Hermes JSI `ArrayBuffer` / `jsi::MutableBuffer`, never
   arrays of numbers.
8. Every operation in `HostOperations`, with the body read as is: the outbox and metadata in
   SQLite (WAL, FULL sync, `BEGIN IMMEDIATE`; the host binding immutable once written),
   snapshots in a separate LRU file (256 records, 32 MiB), secrets in the Android Keystore
   limited to the runtime's own key, the directory file, pinned HTTPS (exact SPKI pin, no
   redirects, 1 MiB body cap), staged attachment chunks as base64, downloads appended to a
   temporary file only at its current length.
9. Errors answer with a `HostErrorCode`.
10. `emit`: accept frames up to 32 KiB, decode them off the UI thread, apply on it, then call
    `aceAck(accepted)`; reassemble `fragment` patches as `BridgeFrames.swift` does. Apply
    `thread.item.text` edits in UTF-8 bytes, checking every edit in a frame before applying any,
    and turn the frame down on a mismatch.
11. `socket`: pinned WSS, binary messages handed over as bytes, `trust` with `pin` on a pin
    mismatch, `close` with the code.
12. Pass the shared contract tests: `packages/native-host/src/contract.test.ts` describes each
    behaviour; port its cases to an instrumented test against the Kotlin host.

The bridge's shaping code (`apps/ios/bridge`) moves to a shared package when Android starts, so
both apps run the same bundle on the same contract.

## Verification

`bunx vitest run packages/native-host apps/ios/bridge`: 220 tests, one failure
(`native-media.test.ts`, which fails the same way on `cab46f601`). Swift: `DurableStoreTests`,
`SnapshotStoreTests`, `SecretStoreTests`, `PatchPumpTests`, `TranscriptHistoryBridgeTests`,
`ClientModelTests`, `BrowserLiveTests` and the fixture-backed `BridgeContractTests` pass on the
iPhone Air simulator. A new pump test fails when `utf8Length` counts UTF-16 units.
