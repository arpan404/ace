/*
 * The simulated links `video-link.ts` puts between the daemon and a viewer (ADR 0149, N1). Pure:
 * every call takes the time it happens at and returns when the bytes arrive, and randomness comes
 * from a seeded generator, so a profile replays exactly and can drive unit tests.
 *
 * The 3G profiles model a phone reaching the Mac through the relay: two TCP legs in series, the
 * Mac to the relay (fast, short) and the relay to the phone (the 3G radio, the bottleneck). The
 * relay forwards each socket message once it has all of it. Each leg is one TCP connection:
 *
 * - **Serialisation.** Bytes leave at the leg's rate, in order.
 * - **Slow start.** The window starts at 10 segments and doubles each round trip in which it
 *   filled; after a loss it grows by one segment per round trip. After an idle longer than the
 *   retransmit timeout it restarts from 10 segments (slow start after idle).
 * - **Loss.** Each segment is lost with the profile's probability. A lost segment followed by at
 *   least three more sent back to back with it (`sendAll`) is fast-retransmitted: it, and
 *   everything behind it, arrives one round trip late. A lost tail (one of the last three, which
 *   can't raise three duplicate acks) waits for the retransmit timeout: the round trip plus a
 *   200 ms minimum. Either loss cuts the window to 0.7 of itself (at least 2 segments), CUBIC's
 *   multiplicative decrease (beta 0.7, RFC 9438), and it grows by one per round trip from there.
 * - **Jitter.** Each segment's one-way delay gains up to the jitter, but delivery stays in order.
 * - **A competing flow.** On the down radio leg, the main session sends a burst every 10 s,
 *   sized at 25 % of what the link carries in those 10 s (125 KB at 400 kbit/s). While a burst is unsent it is a backlogged TCP flow taking a fair half of the link; it takes
 *   all of it while video is idle.
 *
 * The `phone` profile is the original 25 Mbit/s link, kept exactly as it was: one queue at the
 * link's rate, then the one-way delay plus jitter, with no loss, window or ordering.
 */

export type Random = () => number;

/** A seeded uniform generator in [0, 1) (mulberry32), so a run replays exactly. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** One direction of one TCP leg. */
export interface LegSpec {
  kbps: number;
  rttMs: number;
  jitterMs: number;
  /** Probability that a segment is lost, 0–1. */
  loss: number;
  /** Bytes per segment. */
  mss?: number;
  /** Segments in the first window, and after an idle restart. */
  initialWindow?: number;
  /** The retransmit timeout's floor over the round trip. */
  minRtoMs?: number;
  competing?: CompetingFlow;
}

/** The main session's bursts sharing a leg. */
export interface CompetingFlow {
  bytes: number;
  everyMs: number;
  /** When the first burst starts, after the link was created. */
  firstAfterMs: number;
}

/** A socket message entering a path. */
export interface Message {
  bytes: number;
  at: number;
}

/**
 * Something bytes cross. `sendAll` takes messages sent back to back (one call's worth, such as a
 * video chunk's pieces) and returns when each fully arrives; `send` is one message.
 */
export interface Path {
  send(bytes: number, at: number): number;
  sendAll(messages: readonly Message[]): number[];
}

const MSS = 1448;
const INITIAL_WINDOW = 10;
const MIN_RTO_MS = 200;
/** Fast retransmit needs three duplicate acks, so a loss this close to the end is a tail loss. */
const DUP_ACKS = 3;
const MAX_WINDOW = 4096;
/**
 * The window after a loss, as a share of what it was: CUBIC's beta, 0.7 (RFC 9438). Tail losses cut it the same
 * way: tail loss probes turn them into ordinary recovery instead of a collapse to one segment.
 */
const LOSS_BETA = 0.7;

/** One direction of a TCP connection over one leg. */
export class TcpLeg implements Path {
  private readonly bytesPerMs: number;
  private readonly mss: number;
  private readonly initialWindow: number;
  private readonly rtoMs: number;
  private window: number;
  private threshold = Infinity;
  private roundStart = -Infinity;
  private roundSent = 0;
  /** When the sender finishes putting what it has on the wire. */
  private freeAt = -Infinity;
  /** The latest arrival so far: delivery is in order. */
  private delivered = -Infinity;
  private readonly competing: CompetingState | undefined;
  /** Segments lost so far, fast-retransmitted and timed out. */
  readonly losses = { fast: 0, timeout: 0 };

  private readonly spec: LegSpec;
  private readonly random: Random;

  constructor(spec: LegSpec, random: Random, createdAt: number) {
    this.spec = spec;
    this.random = random;
    this.bytesPerMs = (spec.kbps * 1000) / 8 / 1000;
    this.mss = spec.mss ?? MSS;
    this.initialWindow = spec.initialWindow ?? INITIAL_WINDOW;
    this.rtoMs = spec.rttMs + (spec.minRtoMs ?? MIN_RTO_MS);
    this.window = this.initialWindow;
    this.competing = spec.competing && {
      flow: spec.competing,
      left: 0,
      clock: createdAt,
      nextAt: createdAt + spec.competing.firstAfterMs,
    };
  }

  /** The current window, in segments. */
  get windowSegments(): number {
    return this.window;
  }

  /**
   * Bytes of the main session's bursts still unsent at `at`, which must be at or after the last
   * send (it accounts the link as idle up to `at`).
   */
  competingLeft(at: number): number {
    if (!this.competing) return 0;
    this.drainIdle(Math.max(at, this.freeAt));
    return this.competing.left;
  }

  send(bytes: number, at: number): number {
    return this.sendAll([{ bytes, at }])[0] ?? at;
  }

  /** Back-to-back messages: only a loss near the end of the last one is a tail loss. */
  sendAll(messages: readonly Message[]): number[] {
    const counts = messages.map(({ bytes }) => Math.max(1, Math.ceil(bytes / this.mss)));
    let behind = counts.reduce((total, count) => total + count, 0);
    return messages.map(({ bytes, at }, message) => {
      let arrival = at;
      for (let index = 0; index < (counts[message] ?? 1); index++) {
        const size = Math.max(1, Math.min(this.mss, bytes - index * this.mss));
        arrival = this.segment(size, at, --behind);
      }
      return arrival;
    });
  }

  private segment(size: number, at: number, behind: number): number {
    let start = Math.max(at, this.freeAt);
    if (start - this.freeAt > this.rtoMs) {
      this.window = Math.min(this.window, this.initialWindow);
      this.roundStart = start;
      this.roundSent = 0;
    }
    if (start >= this.roundStart + this.spec.rttMs) {
      this.roundStart = start;
      this.roundSent = 0;
    } else if (this.roundSent >= this.window) {
      start = this.roundStart + this.spec.rttMs;
      this.roundStart = start;
      this.roundSent = 0;
      this.window = Math.min(
        MAX_WINDOW,
        this.window < this.threshold ? this.window * 2 : this.window + 1,
      );
    }
    this.drainIdle(start);
    const end = this.serialise(size, start);
    this.freeAt = end;
    this.roundSent++;
    let arrival = end + this.spec.rttMs / 2 + this.random() * this.spec.jitterMs;
    if (this.random() < this.spec.loss) {
      this.window = Math.max(2, Math.floor(this.window * LOSS_BETA));
      this.threshold = this.window;
      if (behind >= DUP_ACKS) {
        this.losses.fast++;
        arrival += this.spec.rttMs;
      } else {
        this.losses.timeout++;
        arrival += this.rtoMs;
      }
    }
    this.delivered = Math.max(this.delivered, arrival);
    return this.delivered;
  }

  /** Sends `size` bytes from `start`, sharing the link with a pending burst; returns the end. */
  private serialise(size: number, start: number): number {
    const competing = this.competing;
    let left = size;
    let clock = start;
    while (left > 0) {
      if (!competing || competing.left <= 0) {
        clock += left / this.bytesPerMs;
        break;
      }
      const half = this.bytesPerMs / 2;
      const step = Math.min(left, competing.left);
      clock += step / half;
      left -= step;
      competing.left -= step;
    }
    if (competing) competing.clock = clock;
    return clock;
  }

  /** The competing flow, alone on the link, up to `to`. */
  private drainIdle(to: number): void {
    const competing = this.competing;
    if (!competing) return;
    for (;;) {
      if (competing.nextAt <= competing.clock) {
        competing.left += competing.flow.bytes;
        competing.nextAt += competing.flow.everyMs;
        continue;
      }
      if (competing.clock >= to) return;
      const until = Math.min(to, competing.nextAt);
      const drainedAt = competing.clock + competing.left / this.bytesPerMs;
      if (drainedAt <= until) {
        competing.left = 0;
        competing.clock = until;
      } else {
        competing.left -= (until - competing.clock) * this.bytesPerMs;
        competing.clock = until;
      }
    }
  }
}

interface CompetingState {
  flow: CompetingFlow;
  left: number;
  clock: number;
  nextAt: number;
}

/** Legs in series: each message crosses the next leg once the previous one delivered all of it. */
export class Relay implements Path {
  readonly legs: readonly Path[];
  constructor(legs: readonly Path[]) {
    this.legs = legs;
  }
  send(bytes: number, at: number): number {
    return this.sendAll([{ bytes, at }])[0] ?? at;
  }
  sendAll(messages: readonly Message[]): number[] {
    let entering = messages;
    for (const leg of this.legs) {
      const arrivals = leg.sendAll(entering);
      entering = entering.map(({ bytes }, index) => ({ bytes, at: arrivals[index] ?? 0 }));
    }
    return entering.map(({ at }) => at);
  }
}

/** The original link: a queue at the link's rate, then the one-way delay plus jitter. */
export class SimpleLink implements Path {
  private freeAt = 0;
  private readonly bytesPerMs: number;
  private readonly oneWayMs: number;
  private readonly jitterMs: number;
  private readonly random: Random;
  constructor(megabits: number, oneWayMs: number, jitterMs: number, random: Random) {
    this.bytesPerMs = (megabits * 1e6) / 8 / 1000;
    this.oneWayMs = oneWayMs;
    this.jitterMs = jitterMs;
    this.random = random;
  }
  send(bytes: number, at: number): number {
    this.freeAt = Math.max(this.freeAt, at) + bytes / this.bytesPerMs;
    return this.freeAt + this.oneWayMs + this.random() * this.jitterMs;
  }
  sendAll(messages: readonly Message[]): number[] {
    return messages.map(({ bytes, at }) => this.send(bytes, at));
  }
}

/** What a 3G profile is held to once M2b lands (the plan's "3G targets"). */
export interface LinkTargets {
  /** Subscribe to the first picture fully arrived, at most. */
  firstPictureMs: number;
  /** Glass-to-glass p50, at most. */
  glassToGlassP50Ms: number;
  /** Frames shown per second, median, at least. */
  fpsMedian: number;
  /** The median picture's coded width, at least. */
  codedWidth: number;
}

export interface LinkProfile {
  name: string;
  downKbps: number;
  upKbps: number;
  /** End to end, both legs. */
  rttMs: number;
  jitterMs: number;
  loss: number;
  competing?: CompetingFlow;
  targets?: LinkTargets;
  /**
   * Whether `targets` fail the run. False until M2b (3G pacing) lands; M2b flips it for the
   * profiles with targets.
   */
  enforced: boolean;
}

/** The Mac to the relay: a wired leg, fast and short. */
const RELAY_LEG = { kbps: 50_000, rttMs: 40, jitterMs: 0 } as const;
const BURST_EVERY_MS = 10_000;
/** The main session's share of the link's average over each burst period. */
const BURST_SHARE = 0.25;
/** A burst every 10 s of 25 % of what the down link carries in that time. */
export function burstsFor(downKbps: number): CompetingFlow {
  return {
    bytes: Math.round((downKbps * 1000 * BURST_SHARE * BURST_EVERY_MS) / 1000 / 8),
    everyMs: BURST_EVERY_MS,
    firstAfterMs: 5_000,
  };
}

export const threeGProfiles = {
  "3g-400": {
    name: "3g-400",
    downKbps: 400,
    upKbps: 200,
    rttMs: 500,
    jitterMs: 30,
    loss: 0.02,
    competing: burstsFor(400),
    targets: { firstPictureMs: 2000, glassToGlassP50Ms: 1500, fpsMedian: 5, codedWidth: 640 },
    enforced: false,
  },
  "3g-800": {
    name: "3g-800",
    downKbps: 800,
    upKbps: 400,
    rttMs: 400,
    jitterMs: 30,
    loss: 0.015,
    competing: burstsFor(800),
    enforced: false,
  },
  "3g-1600": {
    name: "3g-1600",
    downKbps: 1600,
    upKbps: 800,
    rttMs: 300,
    jitterMs: 30,
    loss: 0.01,
    competing: burstsFor(1600),
    targets: { firstPictureMs: 2000, glassToGlassP50Ms: 1000, fpsMedian: 15, codedWidth: 1152 },
    enforced: false,
  },
} as const satisfies Record<string, LinkProfile>;

export type ThreeGProfileName = keyof typeof threeGProfiles;

export function isThreeGProfile(name: string | undefined): name is ThreeGProfileName {
  return name !== undefined && Object.hasOwn(threeGProfiles, name);
}

/** Both directions of a 3G profile through the relay; only the down radio leg competes. */
export function threeGLink(
  profile: LinkProfile,
  random: Random,
  createdAt: number,
): { down: Relay; up: Relay; radio: TcpLeg } {
  const radioRtt = profile.rttMs - RELAY_LEG.rttMs;
  const leg = (kbps: number, competing?: CompetingFlow) =>
    new TcpLeg(
      {
        kbps,
        rttMs: radioRtt,
        jitterMs: profile.jitterMs,
        loss: profile.loss,
        ...(competing ? { competing } : {}),
      },
      random,
      createdAt,
    );
  const wired = () => new TcpLeg({ ...RELAY_LEG, loss: profile.loss }, random, createdAt);
  const radio = leg(profile.downKbps, profile.competing);
  return {
    down: new Relay([wired(), radio]),
    up: new Relay([leg(profile.upKbps), wired()]),
    radio,
  };
}
