import { VideoFanout, type VideoPiece, type VideoWindow } from "../src/video-fanout.ts";
import { LinkRate, linkFloor, type LinkHint, type LinkRateLimits } from "../src/link-rate.ts";
import { simulate, type SimRun } from "./link-sim.ts";

/** One step of a fanout scenario, replayed in order by the Rust port. */
type FanoutOp =
  | { publish: VideoPiece }
  | { ack: number }
  | { refuse: boolean }
  | { flush: true }
  | { assign: true }
  | { bound: number | null };

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
    else if ("ack" in op) fanout.acknowledge("v", op.ack);
    else if ("refuse" in op) accepting = !op.refuse;
    else if ("flush" in op) fanout.flush();
    else if ("bound" in op) fanout.bound("v", op.bound ?? undefined);
    else fanout.assign("v", "e");
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
  | { drop: { at: number } };

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
    else rate.dropped(op.drop.at);
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
    { downlinkKbps: 0.5 },
    { downlinkKbps: -3, rttMs: 1e9 },
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
