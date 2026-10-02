# Model catalog benchmark

Measured 2026-10-02 with `bun run --filter @ace/models bench`, Node 26.8.1,
a 512-model instance, and 100,000 iterations per operation after 1,000 warmup
iterations. This is non-gating and shares the machine with other workers.

| Operation                                                 |    Throughput | Time per operation | Peak process RSS |
| --------------------------------------------------------- | ------------: | -----------------: | ---------------: |
| Cached instance page, 100 models                          | 318,117 ops/s |            3.14 µs |        150.3 MiB |
| Strongest compatible fast policy, preference at final row |  30,300 ops/s |           33.00 µs |        150.7 MiB |

Listing slices only the requested rows. Resolution walks the selected instances
once, stopping when its best preference is available, and does not build an
intermediate flattened catalog. RSS includes the dedicated SQLite worker.
