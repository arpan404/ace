import type { LinkRate } from "../src/link-rate.ts";

/*
 * A link to drive a rate estimator over, for its tests and the shared vectors. Pure and
 * deterministic: chunks queue at the link's bandwidth, then take the one-way delay each way.
 * Every `lossEvery`th chunk is lost once and resent, which holds it (and, TCP being in order,
 * everything behind it) for `stallMs`. The sender holds the viewer's backlog bound, as the
 * fanout does: a chunk that would put more than `backlogBytes` in flight is dropped.
 */
export interface SimLink {
  megabits: number;
  oneWayMs: number;
  lossEvery?: number;
  stallMs?: number;
}

export type Estimator = Pick<
  LinkRate,
  "rate" | "backlogBytes" | "sent" | "acknowledged" | "dropped"
>;

export interface SimRun {
  link: SimLink;
  seconds: number;
  /** Chunks a second; each is the size the current rate allows at this rate. */
  fps?: number;
  start?: number;
  /** The first chunk is a keyframe this many chunks big. */
  firstKey?: number;
}

/** Sequences continue across runs on one estimator, as acks are cumulative. */
const sequences = new WeakMap<Estimator, number>();
/** Drives `rate` over the link; returns its rate at the end of each second. */
export function simulate(rate: Estimator, run: SimRun): number[] {
  const { link, seconds, fps = 60, start = 0, firstKey = 1 } = run;
  const bytesPerMs = (link.megabits * 1e6) / 8 / 1000;
  const acks: { at: number; sequence: number; bytes: number }[] = [];
  let inflight = 0;
  let linkFreeAt = start;
  let deliveredAt = start;
  const rates: number[] = [];
  const end = start + seconds * 1000;
  let second = start + 1000;
  let index = 0;
  let sequence = sequences.get(rate) ?? 0;
  for (let at = start; at < end; at += 1000 / fps, index++) {
    while (acks.length && (acks[0]?.at ?? Infinity) <= at) {
      const ack = acks.shift();
      if (!ack) continue;
      inflight -= ack.bytes;
      rate.acknowledged(ack.sequence, ack.at);
    }
    while (at >= second) {
      rates.push(rate.rate);
      second += 1000;
    }
    const bytes = Math.round((rate.rate / 8 / fps) * (index === 0 ? firstKey : 1));
    if (inflight > 0 && inflight + bytes > (rate.backlogBytes ?? Infinity)) {
      rate.dropped(at);
      continue;
    }
    inflight += bytes;
    rate.sent(++sequence, bytes, at);
    linkFreeAt = Math.max(linkFreeAt, at) + bytes / bytesPerMs;
    const lost = link.lossEvery !== undefined && index % link.lossEvery === link.lossEvery - 1;
    deliveredAt = Math.max(
      deliveredAt,
      linkFreeAt + link.oneWayMs + (lost ? (link.stallMs ?? 0) : 0),
    );
    acks.push({ at: deliveredAt + link.oneWayMs, sequence, bytes });
  }
  sequences.set(rate, sequence);
  while (rates.length < seconds) rates.push(rate.rate);
  return rates;
}
