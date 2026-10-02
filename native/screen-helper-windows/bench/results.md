# Verification and measurements pending at merge

The final revision has static checks only. The repo owner's updated rule prohibits running tests, benchmarks, mutations, flakiness checks or runtime probes before merge. Earlier exploratory tests preceded that rule and do not verify the final revision.

| Measurement                                          | Source or method                                              | Result                           |
| ---------------------------------------------------- | ------------------------------------------------------------- | -------------------------------- |
| 720p tile hash                                       | `core` Rust benchmark                                         | Not executed, needs run at merge |
| 720p JPEG encode                                     | `core` Rust benchmark, synthetic changing pixels              | Not executed, needs run at merge |
| Command decoding                                     | `core` Rust benchmark                                         | Not executed, needs run at merge |
| Pruning a 2048-node tree                             | `core` Rust benchmark, host source trait                      | Not executed, needs run at merge |
| Finding the first ten controls                       | `core` Rust benchmark                                         | Not executed, needs run at merge |
| Reference retention and eviction                     | `core` Rust benchmark                                         | Not executed, needs run at merge |
| 720p JPEG packet construction                        | `core` Rust benchmark                                         | Not executed, needs run at merge |
| Fragmented v2 frame decoding and UI reply validation | `v2.ts` TypeScript benchmark                                  | Not executed, needs run at merge |
| Capture mailbox replacement and retirement           | `core` Rust benchmark                                         | Not executed, needs run at merge |
| Rich MCP 1 MiB image validation                      | `packages/screen/bench/content.ts`                            | Not executed, needs run at merge |
| Bounded line-reader throughput                       | `packages/screen/bench/content.ts`                            | Not executed, needs run at merge |
| Steady and peak host RSS                             | Run benchmark executables under platform resource measurement | Not executed, needs run at merge |
| Windows idle CPU and frame count                     | Unchanging window for 60 seconds, then suspended capture      | Untested on real Windows         |
| Windows CPU at 10 fps and RSS                        | Changing 720p and 4K windows for 60 seconds                   | Untested on real Windows         |
| GPU readback and JPEG latency median/p95             | Instrumented release helper or WPR/ETW                        | Untested on real Windows         |
| Large-app UIA tree latency median/p95                | 100 reads, fixed caps, browser/Explorer                       | Untested on real Windows         |

Record OS build, CPU, GPU/driver, power policy, monitor sizes/DPI and process RSS with each result. No estimated or fabricated numbers substitute for these measurements. The exact runtime plan is in the helper README.
