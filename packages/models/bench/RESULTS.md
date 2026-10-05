# Model catalog benchmark

## PR 137 revision: needs run at merge

No benchmarks, tests or probes were executed during this follow-up. The owner
reserves execution for merge. Current latency, throughput and RSS need run at
merge; historical measurements below do not verify this revision.

The public-catalog workload now includes 512 Claude selectors that collapse to
256 canonical models. It measures a catalog refresh with an in-memory discovery
fixture, a warm page and a settings-generation change. Existing workloads cover
512 native rows, 128 custom rows, dense visibility lists, policy resolution and
OpenCode v2 normalization.

Static review of the implementation shows one native cleanup per cache load or
discovery update. Settings generations reuse those clean rows and choose their
default with a linear scan. Claude alias lookup indexes exact numeric version
prefixes once, followed by one final catalog sort. It does not rescan and sort
the full catalog for each alias. Warm pages still visit the requested rows plus
one lookahead. Startup default migration uses the cached-only resolver and
schedules no CLI discovery; cold discovery belongs to the resumed session.

## PR 129 revision: needs run at merge

The 2026-10-02 measurements below precede provider visibility settings and do
not establish performance of this revision. Per the owner's rule, no benchmark
was executed during this follow-up. Current throughput, latency and RSS all
**need run at merge**.

The updated public-catalog benchmark includes 512 native rows, 512 entries in
each model preference list and 128 custom rows. It measures a warm 100-row page,
a warm one-row page at native offset 511, a warm one-row page at custom offset
639, and a settings-generation change followed by a one-row page. The existing
resolver and OpenCode parser measurements remain available.

Static complexity: preference sets are built once per settings/catalog
generation; warm listing visits the requested page plus at most one lookahead
row. Each row's visibility lookup is O(1). Custom-ID collision detection scans
native IDs once when custom models are configured. A generation retains at most
640 decorated rows per instance (512 discovered + 128 custom), without copying
native raw strings. Resolution still walks candidate rows and is not claimed to
be constant time.

## Historical measurements

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
