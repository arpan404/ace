import { expect, test } from "vitest";
import {
  initialHeartbeat,
  nextAt,
  stepHeartbeat,
  type HeartbeatConfig,
  type HeartbeatInput,
  type HeartbeatState,
} from "./heartbeat-machine.ts";

/** A small seeded generator, so every failing run can be replayed from its seed. */
function generator(seed: number) {
  let value = seed >>> 0;
  const next = () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return { next, int: (low: number, high: number) => low + Math.floor(next() * (high - low + 1)) };
}

interface Scenario {
  config: HeartbeatConfig;
  /** Every wake's probe deadline. */
  deadlineMs: number;
  wakes: number[];
  /** When the socket dies: no ping sent at or after it is ever answered. */
  diesAt: number | undefined;
  /** How long the pong to a ping sent at `sentAt` takes. */
  pongDelay(sentAt: number): number;
  /** Whether the socket refuses this ping (it owes too many pongs). */
  refuses(seq: number): boolean;
  endAt: number;
}

interface Run {
  /** When the machine reported the socket dead, if it did. */
  deadAt: number | undefined;
  pings: number[];
  /** A state that was running with neither a timer nor a regular beat. */
  stranded: boolean;
}

/** Drive the machine over `scenario`, as its shell and a socket would. */
function simulate(scenario: Scenario): Run {
  const { config } = scenario;
  let state: HeartbeatState = initialHeartbeat();
  const pongs: { at: number; seq: number }[] = [];
  const pings: number[] = [];
  let deadAt: number | undefined;
  let stranded = false;
  let lastPongAt = 0;
  let now = 0;
  const feed = (input: HeartbeatInput) => {
    const { state: next, effects } = stepHeartbeat(state, input, config);
    state = next;
    for (const effect of effects) {
      if (effect.type === "missed") {
        deadAt ??= now;
        continue;
      }
      if (scenario.refuses(effect.seq)) {
        feed({ type: "refused", seq: effect.seq, now });
        continue;
      }
      pings.push(now);
      if (scenario.diesAt !== undefined && now >= scenario.diesAt) continue;
      // The daemon answers in order: a pong never overtakes an earlier one.
      const at = Math.max(lastPongAt, now + scenario.pongDelay(now));
      lastPongAt = at;
      pongs.push({ at, seq: effect.seq });
    }
    if (state.running && !state.quiet && nextAt(state) === undefined) stranded = true;
  };
  feed({ type: "start", now: 0 });
  const wakes = [...scenario.wakes];
  while (deadAt === undefined) {
    const timer = nextAt(state);
    const candidates = [pongs[0]?.at, wakes[0], timer].filter(
      (value): value is number => value !== undefined,
    );
    if (!candidates.length) break;
    now = Math.min(...candidates);
    if (now > scenario.endAt) break;
    const pong = pongs[0];
    if (pong && pong.at === now) {
      pongs.shift();
      feed({ type: "frame" });
      feed({ type: "pong", seq: pong.seq, now });
    } else if (wakes[0] === now) {
      wakes.shift();
      feed({ type: "wake", now, withinMs: scenario.deadlineMs });
    } else feed({ type: "timer", now });
  }
  return { deadAt, pings, stranded };
}

/** A random pattern of wakes: scattered, in bursts, or every 250 ms for 20 s. */
function wakePattern(random: ReturnType<typeof generator>, endAt: number): number[] {
  const kind = random.int(0, 2);
  const wakes: number[] = [];
  if (kind === 0) for (let n = random.int(1, 40); n > 0; n--) wakes.push(random.int(0, endAt));
  if (kind === 1) {
    const at = random.int(0, endAt);
    for (let n = 0; n < 200; n++) wakes.push(at + random.int(0, 50));
  }
  if (kind === 2) {
    const from = random.int(0, endAt / 2);
    for (let at = from; at < from + 20_000; at += 250) wakes.push(at);
  }
  return wakes.toSorted((a, b) => a - b);
}

function scenario(seed: number, options: { dies: boolean; refusals: boolean }): Scenario {
  const random = generator(seed);
  const deadlineMs = random.int(2_000, 10_000);
  const config = { intervalMs: random.int(deadlineMs, 20_000), joinMs: 300 };
  const endAt = 60_000;
  const delays = new Map<number, number>();
  return {
    config,
    deadlineMs,
    wakes: wakePattern(random, endAt),
    diesAt: options.dies ? random.int(0, endAt - 15_000) : undefined,
    // A healthy socket answers every ping within its deadline (and within the beat's interval).
    pongDelay: (sentAt) => {
      const known = delays.get(sentAt);
      if (known !== undefined) return known;
      const delay = random.int(0, deadlineMs - 1);
      delays.set(sentAt, delay);
      return delay;
    },
    refuses: () => options.refusals && random.next() < 0.1,
    endAt,
  };
}

const seeds = Array.from({ length: 300 }, (_, index) => index + 1);

test("a socket dead at a wake is reported dead within the join window plus that wake's deadline", () => {
  for (const seed of seeds) {
    const s = scenario(seed, { dies: true, refusals: seed % 2 === 0 });
    const run = simulate(s);
    const diesAt = s.diesAt ?? Infinity;
    const first = s.wakes.find((wake) => wake >= diesAt);
    if (first === undefined) continue;
    const bound = first + s.config.joinMs + s.deadlineMs;
    expect({ seed, deadAt: run.deadAt }).toEqual({ seed, deadAt: expect.any(Number) });
    expect({ seed, late: (run.deadAt ?? Infinity) > bound }).toEqual({ seed, late: false });
  }
});

test("a socket whose pongs all come within the deadline is never reported dead", () => {
  for (const seed of seeds) {
    const s = scenario(seed, { dies: false, refusals: false });
    expect({ seed, deadAt: simulate(s).deadAt }).toEqual({ seed, deadAt: undefined });
  }
});

test("pings go out at most one per join window", () => {
  for (const seed of seeds) {
    const { pings } = simulate(scenario(seed, { dies: seed % 3 === 0, refusals: seed % 2 === 0 }));
    const gaps = pings.slice(1).map((at, index) => at - (pings[index] ?? 0));
    expect({ seed, closest: Math.min(Infinity, ...gaps) >= 300 }).toEqual({ seed, closest: true });
  }
});

test("a running heartbeat always has a timer or its regular beat", () => {
  for (const seed of seeds) {
    const run = simulate(scenario(seed, { dies: seed % 3 === 0, refusals: true }));
    expect({ seed, stranded: run.stranded }).toEqual({ seed, stranded: false });
  }
});

test("200 wakes in a burst and wakes every 250 ms for 20 s keep a healthy socket", () => {
  const healthy = (wakes: number[]): Scenario => ({
    config: { intervalMs: 15_000, joinMs: 300 },
    deadlineMs: 5_000,
    wakes,
    diesAt: undefined,
    pongDelay: () => 400,
    refuses: () => false,
    endAt: 60_000,
  });
  const burst = simulate(healthy(Array.from({ length: 200 }, () => 1_000)));
  expect(burst.deadAt).toBeUndefined();
  expect(burst.pings.filter((at) => at < 2_000)).toEqual([1_000, 1_300]);
  const steady = simulate(healthy(Array.from({ length: 80 }, (_, n) => 1_000 + n * 250)));
  expect(steady.deadAt).toBeUndefined();
});
