# Model catalog benchmark

Measured 2026-10-02 with `bun run --filter @ace/models bench`, Node 26.8.1,
on a machine shared with other workers. List and resolution use a 512-model
instance, 100,000 iterations per operation and 1,000 warmup iterations.
The streaming parser uses 100 complete catalogs after five warmups.

| Operation                                                 |     Throughput | Time per operation | Peak process RSS |
| --------------------------------------------------------- | -------------: | -----------------: | ---------------: |
| Cached instance page, 100 models                          |  285,750 ops/s |            3.50 µs |        154.8 MiB |
| Strongest compatible fast policy, preference at final row |   15,748 ops/s |           63.50 µs |        155.3 MiB |
| Incremental OpenCode verbose catalog, 512 models          | 166 catalogs/s |        6,041.28 µs |        184.1 MiB |

OpenCode processes 640,182 bytes per catalog and 84,750 normalized models/s.
It retains the current native object and bounded normalized rows; it never joins
the complete listing. The benchmark fixture lines exist before timing starts,
as they would when delivered by readline.

Listing slices only the requested rows. Resolution walks selected instances
once and does not build an intermediate flattened catalog. RSS is the cumulative
process peak, including the SQLite worker and benchmark fixtures.

These numbers are non-gating and vary with shared-machine contention. A separate
same-process comparison of the original and corrected pure resolver on identical
512-row inputs measured 14.34 and 12.88 µs/op respectively, with 10,000 iterations
after 1,000 warmups. That comparison isolates policy logic from catalog traversal;
it is not a replacement for the full public catalog measurements above.
