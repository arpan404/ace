import { VideoFanout, type VideoPiece, type VideoWindow } from "../src/video-fanout.ts";
import type { MediaLinkHint as LinkHint } from "@ace/protocol";
import { LinkRate, linkFloor, type LinkRateLimits } from "../src/link-rate.ts";
import { simulate, type SimRun } from "./link-sim.ts";

/** One step of a fanout scenario, replayed in order by the Rust port. */
type FanoutOp =
  | { publish: VideoPiece }
  | { ack: number; generation?: number }
  | { forget: number }
  | { refuse: boolean }
  | { flush: true }
  | { assign: true }
  | { bound: number | null }
  | { restart: true };

const piece = (sequence: number, key: boolean, length: number): FanoutOp => ({
  publish: { sequence, key, bytes: { length } },
});

/** Runs ops against one viewer "v" of encode "e"; it is assigned only by an `assign` op. */
function fanoutScenario(name: string, window: VideoWindow, ops: FanoutOp[]) {
  const events: unknown[] = [];
  let accepting = true;
  const fanout = new VideoFanout<VideoPiece>({
    window,
    keyframe: (encode) => events.push({ keyframe: encode }),
    playing: (id, playing) => events.push({ id, playing }),
    dropped: (id) => events.push({ dropped: id }),
    sent: (_id, sequence, bytes) => events.push({ counted: sequence, bytes }),
  });
  fanout.add("v", {
    send: (chunk) => {
      events.push({ offered: chunk.sequence });
      return accepting;
    },
  });
  for (const op of ops) {
    if ("publish" in op) fanout.publish("e", op.publish);
    else if ("ack" in op) fanout.acknowledge("v", op.ack, op.generation);
    else if ("forget" in op) fanout.forget("v", op.forget);
    else if ("refuse" in op) accepting = !op.refuse;
    else if ("flush" in op) fanout.flush();
    else if ("bound" in op) fanout.bound("v", op.bound ?? undefined);
    else if ("restart" in op) {
      // A new capture: the viewer leaves its encode and joins again, sequences from 0.
      fanout.assign("v", undefined);
      fanout.assign("v", "e");
    } else fanout.assign("v", "e");
  }
  return { name, window, ops, events };
}

const wrap = 2 ** 32;

export function fanoutEdges() {
  return [
    // A refused keyframe keeps its bytes: deltas behind it get the window, however many retries.
    fanoutScenario("refused key keeps its bytes across retries", { frames: 3, bytes: 100 }, [
      { assign: true },
      { refuse: true },
      piece(0, true, 100),
      { flush: true },
      { flush: true },
      { flush: true },
      piece(1, false, 100),
      piece(2, false, 1),
      { refuse: false },
      { flush: true },
      { ack: 0 },
      piece(3, true, 100),
      piece(4, false, 50),
    ]),
    fanoutScenario("acks crossing 2^32", { frames: 4, bytes: 1000 }, [
      { assign: true },
      piece(wrap - 2, true, 10),
      piece(wrap - 1, false, 10),
      piece(wrap, false, 10),
      piece(wrap + 1, false, 10),
      { ack: wrap - 1 },
      piece(wrap + 2, false, 10),
      piece(wrap + 3, false, 10),
      { ack: wrap + 3 },
      piece(wrap + 4, false, 10),
    ]),
    fanoutScenario("stale and future acks", { frames: 4, bytes: 1000 }, [
      { assign: true },
      piece(0, true, 10),
      piece(1, false, 10),
      piece(2, false, 10),
      piece(3, false, 10),
      { ack: 2 },
      { ack: 1 },
      piece(4, false, 10),
      piece(5, false, 10),
      piece(6, false, 10),
      piece(7, false, 10),
      { ack: 99 },
      piece(8, false, 10),
      piece(9, true, 10),
    ]),
    fanoutScenario("zero-byte frames", { frames: 3, bytes: 0 }, [
      { assign: true },
      piece(0, true, 0),
      piece(1, false, 0),
      piece(2, false, 1),
      piece(3, true, 0),
      piece(4, false, 0),
      piece(5, false, 0),
      { ack: 3 },
      piece(6, false, 0),
    ]),
    // ADR 0149: what is in flight is bounded by what the link carries in time.
    fanoutScenario("backlog bounded in time", { frames: 60, bytes: 10_000 }, [
      { assign: true },
      { bound: 250 },
      piece(0, true, 400),
      piece(1, false, 100),
      piece(2, true, 100),
      piece(3, false, 100),
      piece(4, false, 100),
      { ack: 0 },
      piece(5, false, 100),
      piece(6, false, 100),
      { bound: null },
      { ack: 6 },
      piece(7, true, 100),
      piece(8, false, 100),
      piece(9, false, 100),
      piece(10, false, 100),
    ]),
    // A burst of keyframes: each replaces the one waiting, deltas wait behind the newest.
    fanoutScenario("keyframe storm", { frames: 3, bytes: 100 }, [
      { assign: true },
      piece(0, true, 60),
      piece(1, true, 60),
      piece(2, true, 60),
      piece(3, false, 10),
      piece(4, true, 60),
      piece(5, false, 10),
      { ack: 0 },
      piece(6, true, 60),
      piece(7, true, 60),
      { ack: 7 },
      piece(8, false, 10),
    ]),
    // A new capture restarts the sequences (generation 1 → 3). A late ack of the old 101,
    // naming its generation, frees only the old chunks sent before it; the new capture's own
    // ack frees everything sent before it, old 102 included.
    fanoutScenario("sequence reset on a new capture", { frames: 5, bytes: 1000 }, [
      { assign: true },
      piece(100, true, 10),
      piece(101, false, 10),
      piece(102, false, 10),
      { restart: true },
      piece(0, false, 10),
      piece(1, true, 10),
      piece(2, false, 10),
      { ack: 101, generation: 1 },
      piece(3, false, 10),
      piece(4, false, 10),
      piece(5, false, 10),
      { ack: 2 },
      piece(6, true, 10),
      piece(7, false, 10),
    ]),
    // Switching encodes keeps the transport's debt: the old chunks still hold the window
    // (each restart is two changes of encode: generations 1, then 3, 5 and 7). Forgetting
    // generation 5 frees its two chunks; without it the last delta would be dropped.
    fanoutScenario("encode switches keep the transport debt", { frames: 3, bytes: 1000 }, [
      { assign: true },
      piece(100, true, 10),
      piece(101, false, 10),
      piece(102, false, 10),
      { restart: true },
      { restart: true },
      piece(1, true, 10),
      { ack: 102, generation: 1 },
      piece(2, false, 10),
      { restart: true },
      piece(1, true, 10),
      { forget: 5 },
      piece(2, false, 10),
    ]),
    fanoutScenario("viewer joining mid-GOP", { frames: 4, bytes: 1000 }, [
      piece(0, true, 10),
      piece(1, false, 10),
      { assign: true },
      piece(2, false, 10),
      piece(3, false, 10),
      piece(4, true, 10),
      piece(5, false, 10),
    ]),
  ];
}

type RateOp =
  | { sent: { sequence: number; bytes: number; at: number } }
  | { ack: { sequence: number; at: number } }
  | { drop: { at: number } }
  | { reset: true };

const edgeLimits: LinkRateLimits = { min: linkFloor, max: 16_000_000, initial: 1_000_000 };

/** The estimator's state after each op, everything the Rust port must match. */
const state = (rate: LinkRate) => ({
  rate: rate.rate,
  rtt: rate.rtt,
  probing: rate.probing,
  backlogBytes: rate.backlogBytes,
});

/** Runs ops against one estimator; the rate and round trip after each op are the output. */
function rateScenario(name: string, ops: RateOp[], limits = edgeLimits, hint?: LinkHint) {
  const rate = new LinkRate(limits, hint);
  const steps = ops.map((op) => {
    if ("sent" in op) rate.sent(op.sent.sequence, op.sent.bytes, op.sent.at);
    else if ("ack" in op) rate.acknowledged(op.ack.sequence, op.ack.at);
    else if ("drop" in op) rate.dropped(op.drop.at);
    else rate.reset();
    return { op, output: state(rate) };
  });
  return { name, limits, ...(hint ? { hint } : {}), steps };
}

/** A scenario recorded from the link simulation (`link-sim.ts`), replayed op by op. */
function simScenario(name: string, runs: SimRun[], limits = edgeLimits, hint?: LinkHint) {
  const rate = new LinkRate(limits, hint);
  const steps: { op: RateOp; output: ReturnType<typeof state> }[] = [];
  const recorder = {
    get rate() {
      return rate.rate;
    },
    get backlogBytes() {
      return rate.backlogBytes;
    },
    sent(sequence: number, bytes: number, at: number) {
      rate.sent(sequence, bytes, at);
      steps.push({ op: { sent: { sequence, bytes, at } }, output: state(rate) });
    },
    acknowledged(sequence: number, at: number) {
      rate.acknowledged(sequence, at);
      steps.push({ op: { ack: { sequence, at } }, output: state(rate) });
    },
    dropped(at: number) {
      rate.dropped(at);
      steps.push({ op: { drop: { at } }, output: state(rate) });
    },
  };
  for (const run of runs) simulate(recorder, run);
  return { name, limits, ...(hint ? { hint } : {}), steps };
}

const phoneLimits: LinkRateLimits = { min: linkFloor, max: 16_000_000, initial: 1_500_000 };
/**
 * Ten chunks a second, each the rate's tenth: a calm second at 300 ms, a queue that builds to
 * 700 ms, then `calm` chunks of a calm link at 320 ms. Recorded as ops, replayed by the port.
 */
function drainScenario(name: string, calm: number) {
  const rate = new LinkRate(phoneLimits);
  const steps: { op: RateOp; output: ReturnType<typeof state> }[] = [];
  const chunk = (index: number, rtt: number) => {
    const at = index * 100;
    const sent = { sequence: index, bytes: Math.round(rate.rate / 80), at };
    rate.sent(sent.sequence, sent.bytes, sent.at);
    steps.push({ op: { sent }, output: state(rate) });
    rate.acknowledged(index, at + rtt);
    steps.push({ op: { ack: { sequence: index, at: at + rtt } }, output: state(rate) });
  };
  for (let index = 0; index < 10; index++) chunk(index, 300);
  for (let index = 0; index < 15; index++) chunk(10 + index, 300 + Math.min(700, index * 50));
  for (let index = 0; index < calm; index++) chunk(25 + index, 320);
  return { name, limits: phoneLimits, steps };
}

const sendAndAck = (sequence: number, bytes: number, at: number, rtt: number): RateOp[] => [
  { sent: { sequence, bytes, at } },
  { ack: { sequence, at: at + rtt } },
];

export function linkRateEdges() {
  return [
    rateScenario(
      "acks crossing 2^32",
      Array.from({ length: 8 }, (_, i) => sendAndAck(wrap - 4 + i, 40_000, i * 250, 20)).flat(),
    ),
    rateScenario("stale and future acks", [
      ...[1, 2, 3, 4, 5].map((sequence) => ({
        sent: { sequence, bytes: 30_000, at: sequence * 100 },
      })),
      { ack: { sequence: 3, at: 400 } },
      { ack: { sequence: 2, at: 700 } },
      { ack: { sequence: 99, at: 900 } },
      { ack: { sequence: 99, at: 1200 } },
      ...sendAndAck(6, 30_000, 1300, 20),
    ]),
    rateScenario(
      "zero-byte frames",
      Array.from({ length: 6 }, (_, i) => sendAndAck(i, 0, i * 250, i < 3 ? 20 : 200)).flat(),
    ),
    // Acks stop: only the newest outstanding sends are remembered, so one late ack delivers
    // too little to lift the rate past its start; counting all 800 would.
    rateScenario("outstanding sends are bounded", [
      ...Array.from({ length: 800 }, (_, i) => ({
        sent: { sequence: i, bytes: 150, at: i },
      })),
      { ack: { sequence: 799, at: 820 } },
      ...sendAndAck(800, 150, 1050, 30),
    ]),
    // ADR 0149's 3G link: the rate follows it below the old 500 kbit/s floor.
    simScenario(
      "400 kbit/s link",
      [{ link: { megabits: 0.4, oneWayMs: 200 }, seconds: 12, fps: 5 }],
      phoneLimits,
    ),
    simScenario(
      "2 % loss link",
      [
        {
          link: { megabits: 1.6, oneWayMs: 200, lossEvery: 50, stallMs: 400 },
          seconds: 12,
          fps: 15,
        },
      ],
      phoneLimits,
    ),
    rateScenario(
      "a stall of one RTO must not cut",
      [
        ...Array.from({ length: 30 }, (_, i) => sendAndAck(i, 2_000, i * 66, 300)).flat(),
        { sent: { sequence: 30, bytes: 2_000, at: 2_000 } },
        { sent: { sequence: 31, bytes: 2_000, at: 2_066 } },
        { ack: { sequence: 30, at: 2_000 + 300 + 600 } },
        { ack: { sequence: 31, at: 2_000 + 300 + 610 } },
        ...Array.from({ length: 10 }, (_, i) =>
          sendAndAck(32 + i, 2_000, 2_950 + i * 66, 300),
        ).flat(),
      ],
      phoneLimits,
    ),
    rateScenario(
      "persistent queueing must cut",
      Array.from({ length: 60 }, (_, i) =>
        sendAndAck(i, 6_000, i * 50, 100 + Math.max(0, i - 20) * 12),
      ).flat(),
      phoneLimits,
    ),
    simScenario(
      "a hint-led start",
      [{ link: { megabits: 0.4, oneWayMs: 200 }, seconds: 6, fps: 5 }],
      phoneLimits,
      { effectiveType: "3g", downlinkKbps: 700, rttMs: 450 },
    ),
    // The first cut drains the start's queue, then the floor starts afresh (ADR 0149).
    drainScenario("drain after the first cut", 30),
    // A link calm for a few round trips is probed upward faster again.
    drainScenario("probing back up", 70),
    // More acks inside the cut window than the delivery entries: the newest coalesce, and the
    // port must make the same decisions without growing its queue.
    rateScenario(
      "an ack burst past the delivery entries",
      [
        // 320 acks in 1.6 s, more than one entry each would hold...
        ...Array.from({ length: 320 }, (_, i) => sendAndAck(i, 500, i * 5, 20)).flat(),
        // ...then larger chunks while a queue builds and lasts, so a cut comes at about 3 s: its
        // target is what was delivered over the last 1 and 2 s, past the burst's expiry.
        ...Array.from({ length: 40 }, (_, i) =>
          sendAndAck(320 + i, 4_000, 1_600 + i * 50, 20 + Math.min(400, i * 25)),
        ).flat(),
      ],
      phoneLimits,
    ),
    // A new encode restarts sequences: sends before it don't count, and acks of old numbers
    // past the new ones change nothing.
    rateScenario(
      "sequence reset on a new encode",
      [
        ...Array.from({ length: 10 }, (_, i) => sendAndAck(1_000 + i, 2_000, i * 100, 40)).flat(),
        { sent: { sequence: 1_010, bytes: 2_000, at: 1_000 } },
        { reset: true },
        ...Array.from({ length: 10 }, (_, i) => sendAndAck(i, 2_000, 1_050 + i * 100, 40)).flat(),
        { ack: { sequence: 1_010, at: 2_100 } },
      ],
      phoneLimits,
    ),
    // Out of order: an older ack after a newer one changes nothing.
    rateScenario(
      "out-of-order acks",
      [
        ...[0, 1, 2, 3].map((sequence) => ({
          sent: { sequence, bytes: 2_000, at: sequence * 50 },
        })),
        { ack: { sequence: 2, at: 300 } },
        { ack: { sequence: 0, at: 310 } },
        { ack: { sequence: 1, at: 320 } },
        { ack: { sequence: 3, at: 400 } },
      ],
      phoneLimits,
    ),
    // Drops while a loss stalls the link: no cut.
    rateScenario(
      "a drop behind a stalled chunk",
      [
        ...Array.from({ length: 30 }, (_, i) => sendAndAck(i, 2_000, i * 66, 300)).flat(),
        { sent: { sequence: 30, bytes: 2_000, at: 2_000 } },
        { drop: { at: 2_000 + 900 } },
        { drop: { at: 2_000 + 950 } },
        { ack: { sequence: 30, at: 2_000 + 1_000 } },
        ...sendAndAck(31, 2_000, 3_100, 300),
      ],
      phoneLimits,
    ),
  ];
}

/** What a client's hint makes of a viewer's start (ADR 0149 §4). */
export function linkHints() {
  const hints: LinkHint[] = [
    {},
    { effectiveType: "4g", downlinkKbps: 10_000, rttMs: 50 },
    { effectiveType: "3g" },
    { effectiveType: "2g" },
    { effectiveType: "slow-2g", saveData: true },
    { downlinkKbps: 1_600 },
    { downlinkKbps: 1 },
    { downlinkKbps: 0, rttMs: 60_000 },
    { effectiveType: "3G" },
    { rttMs: 450 },
    { saveData: true },
    { constrained: true, expensive: true },
    { expensive: true },
  ];
  return hints.map((hint) => {
    const rate = new LinkRate(phoneLimits, hint);
    return {
      input: { limits: phoneLimits, hint },
      output: { rate: rate.rate, probing: rate.probing },
    };
  });
}
