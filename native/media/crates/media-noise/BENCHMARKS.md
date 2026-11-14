<!-- SPDX-License-Identifier: Apache-2.0 -->

# Seal measurements

Apple M4 Max, 16 logical CPUs, Rust 1.95.0, release LTO, CARGO_BUILD_JOBS=4.
Command from `native/media`: `cargo run --release -p media-noise --example seal`.
Decimal MB/s, single foreground thread. TS baseline in the plan: about 240 MB/s.

The final run started at load 11.86 and failed the 1,500 MB/s gate (exit 1).
A subsequent load probe returned 528.55. Earlier runs started above 700 and correctly
reported without enforcing. These results are affected by host contention; they do
not establish acceptance. Repeat on an idle host before merging.

| Path                    | Frame bytes |    MB/s |    ns/frame |
| ----------------------- | ----------: | ------: | ----------: |
| RustCrypto 0.11.0 seal  |          64 |  46.339 |   1,381.140 |
| ring 0.17.14 seal       |          64 |  55.624 |   1,150.576 |
| Transport seal          |          64 |  30.974 |   2,066.230 |
| Transport open and wipe |          64 |  96.095 |     666.005 |
| RustCrypto 0.11.0 seal  |       1,200 | 106.449 |  11,273.046 |
| ring 0.17.14 seal       |       1,200 | 313.436 |   3,828.538 |
| Transport seal          |       1,200 | 244.110 |   4,915.825 |
| Transport open and wipe |       1,200 | 123.392 |   9,725.132 |
| RustCrypto 0.11.0 seal  |      65,519 | 184.412 | 355,285.801 |
| ring 0.17.14 seal       |      65,519 | 369.387 | 177,372.163 |
| Transport seal          |      65,519 | 217.453 | 301,302.168 |
| Transport open and wipe |      65,519 | 186.093 | 352,075.735 |

Both candidates passed `cargo deny check licenses sources`. ring was faster at each
size in this run and is the runtime choice. RustCrypto is a dev dependency for the
comparison only. The initial RustCrypto 0.10.1 comparison measured 404 MB/s versus
ring's 1,581 MB/s for full frames at starting load 722.23. Upgrading the comparison
to 0.11.0 enables its arm64 NEON backend; the runtime choice stayed ring.

Raw AEAD comparisons reuse buffers and exclude allocation; transport encryption
retains its outputs and transport decryption includes zeroizing the result on drop.
Comparisons between paths measured at different moments are sensitive to scheduling.
The 1.5 GB/s gate applies to the public transport encryption path, not the faster raw
backend result. JSON lines include the starting load and report-only decision.
