<!-- SPDX-License-Identifier: Apache-2.0 -->

# Seal measurements

Apple M4 Max, 16 logical CPUs, Rust 1.95.0, release profile (opt-level 3, LTO,
codegen-units 1, no debug assertions). Command from `native/media`:
`cargo run --release -p media-noise --example seal`. Decimal MB/s, single foreground
thread, median of three runs per row. TS baseline in the plan: about 240 MB/s.

## Host load decides the wall numbers

Until 08:27 on 2026-11-14, every run had a load average between 170 and 600 on 16 CPUs, from other
agent sessions; the earlier 369 MB/s (ring) and 301 µs per transport frame were taken
at loads of 528 to 722. Under that contention the bench thread gets a fraction of a
core, so wall throughput swings between runs by up to three times. Thread CPU time
stays steady, and it matches an independent reference measured on the same host at
the same moment: OpenSSL 3 `speed -evp chacha20-poly1305 -bytes 65536` gave
1,703 MB/s at load 603 and 1,715 MB/s at load 577.

The build was not the cause. ring's ARMv8 objects (`chacha20_poly1305_armv8`,
`chacha-armv8`) are linked, RustCrypto 0.11.0 uses its NEON backend, and raising the
thread to user-interactive QoS changed nothing.

## Avoidable work in the transport path (fixed)

The public path allocated a new `Vec` and copied the plaintext for every sealed frame,
on top of the fragmenter's own allocation and copy; opening copied the frame and wiped
the copy. The previous bench also kept every ciphertext (about 6.5 GB at full frames),
so its transport rows mostly measured page faults. Transport now has
`Fragments::next_into`, `RelayStream::seal_in_place` and `open_in_place` over one
reused buffer per stream. Sealing in place overwrites the plaintext, so no wipe is
needed. `seal` and `open` are copying wrappers over the same code, and the shared TS
transcripts pass through both.

## Full frames (65,519 bytes)

Before: the previous bench, three runs at load 190 to 194.

| Path                 | MB/s (wall) |
| -------------------- | ----------: |
| RustCrypto 0.11.0    |         516 |
| ring 0.17.14         |         959 |
| Transport seal (old) |         472 |
| Transport open (old) |         551 |

After: the current bench, run at load 444 to 472.

| Path              | MB/s (wall) | µs/frame | MB per CPU second |
| ----------------- | ----------: | -------: | ----------------: |
| RustCrypto 0.11.0 |         539 |    121.6 |               790 |
| ring 0.17.14      |       1,443 |     45.4 |             1,660 |
| Transport seal    |       1,426 |     46.0 |             1,612 |
| Transport open    |       1,324 |     49.5 |             1,580 |

Two further runs, at loads 540 to 590, gave per-CPU-second values for transport seal
of 1,585 and 1,568 MB/s and for ring of 1,672 and 1,625 MB/s, with wall values
between 344 and 1,167 MB/s. In-place transport seal per CPU second is within 3 % of
raw ring.

## Smaller frames, same run at load 444 to 465

| Path              | Frame bytes | MB/s (wall) | MB per CPU second |
| ----------------- | ----------: | ----------: | ----------------: |
| RustCrypto 0.11.0 |          64 |         116 |               133 |
| ring 0.17.14      |          64 |         273 |               338 |
| Transport seal    |          64 |         238 |               295 |
| Transport open    |          64 |         281 |               317 |
| RustCrypto 0.11.0 |       1,200 |         531 |               591 |
| ring 0.17.14      |       1,200 |       1,305 |             1,447 |
| Transport seal    |       1,200 |         597 |             1,389 |
| Transport open    |       1,200 |         884 |             1,224 |

## Gate: transport seal at full frames, wall time

The gate applies to wall throughput of transport seal at full frames. The bench
enforces it only when the starting load is under twice the CPU count.

Idle run, 2026-11-14 08:38, started at load 15.72 (below the 16 CPUs) and drifting
to 19.5 by the full-frame rows. The bench enforced the gate and exited 0. This build
wipes buffers on failure and derives the rekey in a fixed array.

| Path              | Frame bytes | MB/s (wall) | µs/frame | MB per CPU second |
| ----------------- | ----------: | ----------: | -------: | ----------------: |
| RustCrypto 0.11.0 |          64 |         158 |     0.40 |               162 |
| ring 0.17.14      |          64 |         407 |     0.16 |               420 |
| Transport seal    |          64 |         358 |     0.18 |               362 |
| Transport open    |          64 |         383 |     0.17 |               393 |
| RustCrypto 0.11.0 |       1,200 |         706 |     1.70 |               726 |
| ring 0.17.14      |       1,200 |       1,703 |     0.70 |             1,757 |
| Transport seal    |       1,200 |       1,511 |     0.79 |             1,559 |
| Transport open    |       1,200 |       1,405 |     0.85 |             1,435 |
| RustCrypto 0.11.0 |      65,519 |         902 |    72.66 |               919 |
| ring 0.17.14      |      65,519 |       1,720 |    38.09 |             1,831 |
| Transport seal    |      65,519 |       1,767 |    37.08 |             1,881 |
| Transport open    |      65,519 |       1,803 |    36.33 |             1,834 |

The load stayed under 16 for less than a minute. The enforced runs around it, at
starting loads from 16 to 29, gave transport seal medians of 1,908 to 1,994 MB/s, all
exit 0. With the host fully quiet, ring per CPU second settles at about 2,070 MB/s and
transport seal at about 2,025 MB/s.

Both candidates passed `cargo deny check licenses sources`. ring is the runtime
choice; RustCrypto is a dev dependency for the comparison only.
