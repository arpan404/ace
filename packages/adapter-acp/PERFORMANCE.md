# ACP refresh benchmark

The measurements below were collected before the owner prohibited runtime verification. Do not run this benchmark during development. Final-head confirmation **needs run at merge**.

For merge-time verification only, `node packages/adapter-acp/bench/refreshes.ts` runs from the repository root. This offline probe measures translation, core application and JSON serialization of every emitted event. It sends no provider requests and imposes no timing budget on tests.

Measured on Node v26.8.1 after warm-up. CPU and wall columns are independent medians of three sequential runs; ranges show all three wall observations. Process CPU includes user and system time. Host scheduling makes wall times noisy, so timings are informational. Event bytes were identical across all runs.

| Constant-size refreshes | Emitted bytes | Maximum raw payloads/tool | CPU ms | Wall ms | Wall range ms |
| ----------------------- | ------------: | ------------------------: | -----: | ------: | ------------: |
| 500                     |       672,576 |                         2 |  72.05 |  192.28 |  89.84–311.97 |
| 1,000                   |     1,345,076 |                         2 |  82.83 |  496.15 | 459.93–571.55 |
| 2,000                   |     2,692,076 |                         2 | 155.50 |  906.55 | 696.54–997.90 |

Each constant-size refresh carries a 512-character unknown extension. Counts include the initial call. Retaining the initial complete frame now preserves unknown initial metadata as well as original input, increasing the constant bytes per event from the previous round while retaining linear growth.

| Distinct partial input additions | Emitted bytes | Maximum raw payloads/tool | CPU ms | Wall ms | Wall range ms |
| -------------------------------- | ------------: | ------------------------: | -----: | ------: | ------------: |
| 100                              |       104,080 |                         2 |  13.43 |    8.21 |    6.45–76.01 |
| 200                              |       205,880 |                         2 |  14.33 |   13.24 |   12.07–15.19 |
| 400                              |       409,480 |                         2 |  31.47 |  320.89 | 169.41–511.95 |

Each partial update adds one distinct top-level input field containing 64 characters. These counts exclude one initial call and one terminal update, but their events are included in bytes and time. The terminal snapshot contains every collected field. The behavior test checks every changed field while streaming, every field at completion, and deterministic byte growth below 2.25× when the update count doubles. No elapsed-time assertion gates tests.

Input interpretation carries the fixed fields used by tool mapping plus the latest input change. The raw collector stores each input field's latest value without copying its accumulated map. Live snapshots retain the initial frame, original nonempty input/name, interpreted fields and latest complete frame. Every intermediate frame remains in the append-only event log. Native completion or synthetic cancellation assembles the full input once in the canonical snapshot; this terminal operation costs the final input size. Completed MCP arguments use that assembled input too. Unknown initial metadata and malformed frames stay raw.

The verifier's accumulated-input workload emitted 447,785/1,670,685/6,456,485 bytes for 100/200/400 additions. The new workload includes final assembly and has a different envelope, so these figures demonstrate the removed quadratic growth rather than an exact timing speedup. Two raw slots alone are not the performance argument: intermediate payloads no longer include the growing input history. Retained input memory is proportional to actual native input size, not refresh count for repeatedly changed fields. Payload byte size remains provider-dependent; daemon blob caps belong to ADR 0006.

| Historical completed children | Notifications | CPU ms | Wall ms | Wall range ms |
| ----------------------------- | ------------: | -----: | ------: | ------------: |
| 500                           |       100,000 |  35.84 |  250.17 |  67.15–430.89 |
| 1,000                         |       100,000 |  28.78 |  159.59 |  30.91–326.48 |
| 2,000                         |       100,000 |  29.36 |  224.04 | 106.29–253.75 |

Routing uses constant-time live-child and key indexes. This pure routing measurement excludes history setup. Cascade traversal visits the selected subtree once through parent adjacency. Completed intermediates remain indexed so a live grandchild stays reachable. Assistant diagnostic retention remains an 8 KiB prefix; canonical deltas retain the full transcript.

After merging main through `19a7e14`, a confirmation run emitted the identical byte totals in both workloads. Partial-input CPU times were 19.09/16.46/38.96 ms for 100/200/400 additions; wall times were 239.65/225.24/622.77 ms under concurrent host load. The deterministic scaling result is unchanged.
