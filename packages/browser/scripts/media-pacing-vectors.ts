import { VideoFanout, type VideoPiece, type VideoWindow } from "../src/video-fanout.ts";
import { LinkRate } from "../src/link-rate.ts";

/** One step of a fanout scenario, replayed in order by the Rust port. */
type FanoutOp =
  | { publish: VideoPiece }
  | { ack: number }
  | { refuse: boolean }
  | { flush: true }
  | { assign: true };

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

/** Runs ops against one estimator; the rate and round trip after each op are the output. */
function rateScenario(name: string, ops: RateOp[]) {
  const rate = new LinkRate({ min: 500_000, max: 16_000_000, initial: 1_000_000 });
  const steps = ops.map((op) => {
    if ("sent" in op) rate.sent(op.sent.sequence, op.sent.bytes, op.sent.at);
    else if ("ack" in op) rate.acknowledged(op.ack.sequence, op.ack.at);
    else rate.dropped(op.drop.at);
    return { op, output: { rate: rate.rate, rtt: rate.rtt } };
  });
  return { name, steps };
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
  ];
}
