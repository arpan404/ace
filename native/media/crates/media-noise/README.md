<!-- SPDX-License-Identifier: Apache-2.0 -->

# Media relay transport

Transport only, from Noise revision 34 sections 5.1, 11.3 and 12.3 and RFC 8439.
There is no handshake, identity key, socket, clock, runtime or authorization decision here.

`RelayStream::import` consumes a `Zeroizing<Vec<u8>>` containing K1's 120-byte key
block, decodes it with `media_wire::keys::KeyBlock`, wipes the payload before installing
state, and restores both directional nonces, frame counts and flow accounting. The
handover requires an empty reader queue, so uncounted is zero and unacked equals owed.
The daemon must admit the media connection before handing over its keys.

Every encrypted frame, including credit, passes through `seal` or `open`. Rekey follows
the frame at each multiple of 2^20 and preserves the next nonce. Authentication failure
closes both directions. The socket owner handles credit immediately, calls `received`
on data arrival and `consumed` when the reader takes it, and waits for `allows` before
spending and sealing data. Credit bypasses that wait. `Fragments` splits outgoing
messages at 65,518 data bytes; `MessageAssembler` checks kinds and limits while joining.
Deflated bytes stay compressed here; bounded inflation and parsing belong to the caller.

Keys have no formatting or serialization traits. Raw keys use `Zeroizing<[u8; 32]>`.
A stable, page-aligned allocation holds each raw key and ring's expanded key. The OS
boundary attempts mlock or VirtualLock, and on Windows registers the allocation with
WER's excluded-memory API. Separate 64 KiB allocations avoid shared-page unlocks on
the supported platforms. Failure to lock is tolerated. On rekey and drop, ring's
initialized key is dropped, then its entire storage (including padding) is wiped with
zeroize through `MaybeUninit<u8>`; raw keys and decrypted buffers are wiped too.
ring is pinned at 0.17.14: its ChaCha key is inline, with no heap-owned schedule. Recheck
that property before upgrading. As with other cryptographic libraries, compiler or
backend transient register and stack copies are outside the owned-buffer guarantee.

The process owner must install `install_payload_free_panic_hook` before reading control
payloads and disable core dumps as required by ADR 0147. This library does not change
process-global settings on import. The panic hook is exercised in a child process with
a secret panic payload and checked for its absence from both output streams.

## Check and benchmark

From the repository root, run `bun run check:media` and `bun run fmt:check`.
The crate consumes every K1 noise, flow-credit and relay-fragment transcript. Tests
also align TS frames 15 and 16 to the production rekey boundary after handover.
A temporary big-endian nonce mutation failed the recorded ciphertext test; it was reverted.

From `native/media`, run:

```sh
cargo run --release -p media-noise --example seal
```

This is bench/seal, located in the M4-owned crate. Each result is a JSON line with
frame size, throughput, per-frame wall time and starting host load. It compares ring
0.17.14 with RustCrypto chacha20poly1305 0.11.0 (benchmark dependency only), then measures
the public cipher's allocating encryption and wipe-on-drop decryption paths. The
transport encryption measurement includes retaining ciphertexts; raw AEAD measurements
reuse a buffer and discard detached tags. Both implementations use their SIMD backends
on this arm64 Mac. Both pass the workspace license/source policy.

The benchmark fails below 1,500 MB/s for full-size transport encryption, unless
`ACE_MEDIA_BENCH_REPORT_ONLY=1` or the starting load exceeds twice the CPU count.
TS's plan baseline is approximately 240 MB/s. Loaded-machine results do not establish
the acceptance gate; rerun on an idle machine before merging.
