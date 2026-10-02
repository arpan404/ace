# Relay transfer measurements

Measured on 2026-10-02 with native Node 24.21.0, macOS/ARM64, loopback TCP, noble 2.0.1 and the public host/client helpers. A daemon message carries 1 MiB of JSON string data. After 16 MiB of warmup, the benchmark sends 300 or 600 MiB while receiving concurrently. It checks every received message's type and payload size. The separate 10 MiB behavioral test checks full payload equality and reverse traffic under a stalled reader.

```sh
node apps/relay/bench/throughput.ts
UNLIMITED=1 node apps/relay/bench/throughput.ts
TOTAL_MIB=600 node apps/relay/bench/throughput.ts
MESSAGE_BURST=20 node apps/relay/bench/throughput.ts
```

`TOTAL_MIB`, `MESSAGE_MIB`, `MESSAGES_PER_SECOND` and `MESSAGE_BURST` configure the benchmark. `UNLIMITED=1` raises the budget to 100,000 frames/s and burst 100,000 to measure implementation throughput without policy throttling.

| Configuration                | Transfer |  Elapsed |  Throughput | Process CPU |   Warm RSS | Sampled peak RSS | Throttled frames |
| ---------------------------- | -------: | -------: | ----------: | ----------: | ---------: | ---------------: | ---------------: |
| Unthrottled, run 1           |  300 MiB |  3.284 s | 91.34 MiB/s |     3.976 s | 202.58 MiB |       276.44 MiB |                0 |
| Unthrottled, run 2           |  300 MiB |  3.110 s | 96.46 MiB/s |     3.841 s | 203.08 MiB |       282.39 MiB |                0 |
| Defaults: 1000/s, burst 2000 |  300 MiB |  3.192 s | 93.97 MiB/s |     3.929 s | 207.36 MiB |       301.50 MiB |               73 |
| Defaults, longer run         |  600 MiB | 13.110 s | 45.77 MiB/s |     9.154 s | 223.69 MiB |       331.30 MiB |                0 |
| 1000/s, burst 20             |  300 MiB |  5.257 s | 57.06 MiB/s |     5.150 s | 204.20 MiB |       258.47 MiB |             1829 |

Every transfer completed without a dropped or closed stream. The small-burst run exercises refill repeatedly: 17 encrypted frames per 1 MiB message give a steady theoretical ceiling of about 58.82 MiB/s at 1000 frames/s. Its measured 57.06 MiB/s follows that policy instead of disconnecting the client.

The sampled destination-buffer peak stayed at or below 262,509 bytes in every run, below the 1 MiB hard cap. Peak queued-reader samples were at most 65,535 bytes. RSS includes V8's heap, garbage collection, JSON copies, cryptographic allocations and all three local roles; it is not a measurement of relay queues alone. Doubling transferred data from 300 to 600 MiB increased sampled peak RSS by about 30 MiB, while the queue caps remained fixed. The behavioral test also refuses an additional 10 MiB send while the first is blocked, verifying actual admission rather than a loose buffer inequality. RSS measurements are reported, not used as flaky gating thresholds.

The shared development host runs other workers. Repeated measurements varied with scheduler load: an earlier unthrottled run reached 97.41 MiB/s, and slower runs took materially more wall time than CPU time. A same-script pre-review snapshot (`26d0296`) measured 97.28 MiB/s in an earlier pass; subsequent loaded baseline runs measured 42.09 and 58.81 MiB/s. The later unthrottled baseline consumed 4.021 CPU seconds versus 3.841–3.976 for the final runs. These measurements support comparable processing cost, not a universal speedup claim. The review's roughly 105 MB/s observation and the final 96.46 MiB/s (101.15 MB/s) are close; host-load variability prevents a precise regression percentage.

Frame processing is proportional to frame bytes. IP normalization happens once on upgrade; token decisions and inactive LRU operations use constant-time map operations. Unthrottled reads do not pause/resume the TCP socket or allocate refill timers. Throttled peers share one FIFO queue and timer per IP bucket. Routing, deadlines and device admission are separate from the forwarding loop.
