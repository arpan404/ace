# Notification benchmarks

Non-gating runs on 2026-10-02, Node v26.8.1, darwin/arm64, shared machine. Rates include input schema parsing. RSS is process-wide cumulative peak, including worker threads and earlier phases; it is not a steady-state allocation count. Run `bun run --filter @ace/notify bench` and `bun run --filter @ace/notify bench:backlog` separately.

| Existing path                            |       ops/s |  µs/op | Peak RSS MiB |
| ---------------------------------------- | ----------: | -----: | -----------: |
| Batched delta ingestion                  |   1,297,279 |   0.77 |        157.0 |
| Status transition and durable coalescing |      11,934 |  83.79 |        226.5 |
| Burst and one-device delivery            |       2,217 | 451.16 |        232.7 |
| Sixteen-device fan-out (messages)        |      11,153 |  89.66 |        237.7 |
| Web Push ephemeral key and aes128gcm     |       4,814 | 207.72 |        245.1 |
| Uncached VAPID signing                   |      17,651 |  56.66 |        246.8 |
| Worker delta ingestion                   |     994,628 |   1.01 |        251.5 |
| Indexed presence lookup                  | 123,397,118 |   0.01 |        251.5 |

| Backlog and boundary path                                   |   ops/s |  µs/op | Peak RSS MiB |
| ----------------------------------------------------------- | ------: | -----: | -----------: |
| 1,001-thread replay admission (threads)                     |  30,848 |  32.42 |        116.5 |
| 1,001-thread backlog delivery (messages)                    |  37,515 |  26.66 |        119.8 |
| 10,001-thread spool admission (threads)                     |  49,762 |  20.10 |        194.3 |
| Full spool delivery (messages)                              |  48,804 |  20.49 |        208.5 |
| Actionable link and delivery with 2,048 excluded questions  |   9,345 | 107.01 |        217.9 |
| Owner status change (affected interaction rows)             | 410,629 |   2.44 |        222.0 |
| Worker admission with two distinct unused 8-MiB identifiers |  21,162 |  47.25 |        260.6 |

The 1,001-thread case accepted 1,001 deliveries and reached cursor 2002. The 10,001-thread case retained the latest 10,000 alerts and reached cursor 20002. Input is generated incrementally rather than retained as a history array. The giant-metadata case reached cursor 1000; the largest observed worker frame was 235 bytes. Its peak RSS after forcing allocation of the source strings was 251.6 MiB, versus 260.6 MiB after 1,000 admissions. Machine load and GC timing affect these numbers; no timing or RSS threshold gates CI.
