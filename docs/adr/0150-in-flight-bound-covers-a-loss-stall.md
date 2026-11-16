# 0150: The in-flight bound covers one loss stall

Status: accepted. Date: 2026-11-14. Decided by: the owner (M2b review, 2026-11-14). Amends
[ADR 0149](0149-media-holds-up-on-3g.md) (decision 2, "the backlog is bounded in time").

## Context

ADR 0149 bounds a viewer's bytes in flight at link capacity × (RTT + 300 ms). A delta that
doesn't fit waits briefly, then is dropped. The drop asks the encoder for a keyframe and cuts
the rate.

The phones this is for reach the Mac through the relay, with TCP on both legs. TCP hides a lost
segment by stalling: a lost tail segment waits for the retransmit timeout, which is at least
200 ms on top of the round trip. On a 300–500 ms link, one tail-loss recovery holds the oldest
chunk in flight for about 2 × RTT + 200 ms. That is longer than RTT + 300 ms whenever the RTT is
over 100 ms.

Traces of `packages/browser/bench/video-link.ts` on the `3g-1600` profile (1.6 Mbit/s, 300 ms,
1 % loss, a main-session burst every 10 s), in windows with load below 24 on 16 cores, showed:

- **Drops.** About 7 drops and 10–11 keyframes per 20 s. The oldest chunk in flight was 0.7–1.3 s
  old at each drop.
- **Throughput.** About 0.5 Mbit/s sent. Each keyframe is half a second of the rate.
- **The ladder.** The plan's step ladder needs about 0.62 Mbit/s held steady for 15 fps at
  readable size, so the view sat at 5 fps.

With the bound stretched to cover one stall, the same profile sent 0.62–0.65 Mbit/s with 4–5
keyframes per 20 s, at 870–910 ms glass-to-glass p50. Those runs were on a busier Mac (load 37–48),
so the numbers are indicative.

## Options considered

1. **Keep RTT + 300 ms.** Lag stays lowest, but every tail loss on a long link costs a keyframe
   and a cut, and 3G throughput stays near half of what the link carries.
2. **Stretch the slack to cover one tail-loss recovery:** RTT + max(300 ms, RTT + 200 ms). A
   single stall no longer drops deltas. The extra lag is bounded and only grows during a stall.
3. **Tell a stall from a queue before dropping.** The estimator already does this from the
   round trip once the stalled chunk is acknowledged, and from the oldest chunk's age when a
   drop comes. Doing it before the drop needs a per-chunk timer on the hot path, and it still
   has to decide what to do with deltas that arrive during the stall. It can come later, on top
   of option 2.

## Decision

Option 2. A viewer's bytes in flight are bounded by:

- link capacity × (RTT + max(300 ms, RTT + 200 ms));
- where RTT is the path's round trip: the estimator's floor, not the smoothed round trip, so a
  queue can't widen its own bound;
- and 200 ms is TCP's minimum retransmit timeout.

The rest of ADR 0149's decision 2 stands:

- a lone keyframe may exceed the bound;
- a delta the bound holds back waits, up to the bound's bytes again, then is dropped;
- the frame and byte windows still apply.

`LinkRate.backlogBytes` (`packages/browser/src/link-rate.ts`) and `LinkRate::backlog_bytes`
(`native/media/crates/media-core/src/link_rate.rs`) own the rule.

## Consequences

- **Lag.** Worst-case lag during a stall is about 2 · RTT + 200 ms of in-flight data: about 1.2 s at
  500 ms. It stays bounded, and it is reached only while a loss is being recovered. Outside a
  stall the queue the sender builds is unchanged, because the estimator still cuts on queueing
  that lasts.
- **Short links.** Under 100 ms of RTT, the bound is unchanged: RTT + 300 ms.
- **Keyframes.** Fewer keyframes on lossy long links, so more of the rate goes to the picture.

## Tests

- `link-rate.test.ts`: "bounds the bytes in flight to the rate over the round trip plus one
  tail-loss stall". It pins RTT + max(300 ms, RTT + 200 ms) at a 300 ms round trip, and the
  300 ms slack at a 50 ms one.
- The shared vectors (`native/media/vectors/link-rate-edges`) record `backlogBytes` after every
  op, and `media-core`'s replay checks them within a byte.
- `video-link.ts` on `3g-1600` and `3g-400` measures the effect on drops, keyframes, throughput
  and lag.
