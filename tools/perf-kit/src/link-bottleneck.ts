/**
 * One direction of a shaped link, shared by every connection crossing it, as pure arithmetic on
 * times: no sockets, no timers. Bytes a connection writes are cut into segments and wait in its
 * queue. The bottleneck sends one segment at a time at the link's rate, taking turns between
 * connections that have something queued (round robin per segment, so parallel transfers share
 * the rate fairly), then each segment takes the one-way delay to arrive. A lost segment arrives
 * one stall later, and TCP delivers each connection in order, so nothing after it on that
 * connection arrives sooner; other connections are not held up.
 *
 * Each segment is chosen only once the link is free at that moment (`pump(now)`), so data
 * written later is never overtaken by a decision made early. The shaper (link-shaper.ts) calls
 * `pump` when data is written and at `wakeAt()`, and turns the arrival times into deliveries.
 */
export interface BottleneckOptions {
  /** `null` serializes instantly. */
  bitsPerSecond: number | null;
  delayMs: number;
  loss: number;
  stallMs: number;
  random: () => number;
  /** TCP's maximum segment size on a 1500-byte path. */
  segmentBytes?: number;
}

/** A segment of one connection's bytes and when it reaches the other end. */
export interface Arrival {
  flow: number;
  bytes: Uint8Array;
  at: number;
}

interface Queued {
  bytes: Uint8Array;
  /** When it was written: it cannot leave before. */
  since: number;
}

interface Flow {
  queue: Queued[];
  queuedBytes: number;
  /** Nothing leaves before this: a new connection's handshake. */
  hold: number;
  lastArrival: number;
}

export class Bottleneck {
  private busyUntil = Number.NEGATIVE_INFINITY;
  private stalledSegments = 0;
  private readonly flows = new Map<number, Flow>();
  /** Flow ids in the order they take turns; `turn` is the next to be offered the link. */
  private order: number[] = [];
  private turn = 0;
  private readonly segment: number;
  private readonly options: BottleneckOptions;

  constructor(options: BottleneckOptions) {
    this.options = options;
    this.segment = options.segmentBytes ?? 1460;
  }

  /** A new connection; with `holdUntil`, its first byte leaves no earlier than that. */
  open(flow: number, holdUntil = Number.NEGATIVE_INFINITY): void {
    this.flows.set(flow, { queue: [], queuedBytes: 0, hold: holdUntil, lastArrival: 0 });
    this.order.push(flow);
  }

  /** The connection is gone: what it had queued never leaves. */
  close(flow: number): void {
    this.flows.delete(flow);
    const index = this.order.indexOf(flow);
    if (index === -1) return;
    this.order.splice(index, 1);
    if (this.turn > index) this.turn--;
    if (this.turn >= this.order.length) this.turn = 0;
  }

  /** `bytes` written on `flow` at `now`; they leave as `pump` gives them the link. */
  write(flow: number, now: number, bytes: Uint8Array): void {
    const state = this.flows.get(flow);
    if (!state || bytes.length === 0) return;
    const { bitsPerSecond, loss } = this.options;
    // Unshaped and lossless: segments change nothing, so a chunk travels whole.
    const size = bitsPerSecond === null && loss === 0 ? bytes.length : this.segment;
    for (let start = 0; start < bytes.length; start += size)
      state.queue.push({ bytes: bytes.subarray(start, start + size), since: now });
    state.queuedBytes += bytes.length;
  }

  /** Gives the link to queued segments up to `now`, in turn, and says when each arrives. */
  pump(now: number): Arrival[] {
    const { bitsPerSecond, delayMs, loss, stallMs, random } = this.options;
    const arrivals: Arrival[] = [];
    for (;;) {
      const startAt = this.wakeAt();
      if (startAt === undefined || startAt > now) return arrivals;
      const flow = this.nextFlow(startAt);
      const state = flow === undefined ? undefined : this.flows.get(flow);
      const segment = state?.queue.shift();
      if (flow === undefined || !state || !segment) return arrivals;
      state.queuedBytes -= segment.bytes.length;
      const serialized =
        bitsPerSecond === null ? 0 : (segment.bytes.length * 8 * 1000) / bitsPerSecond;
      this.busyUntil = startAt + serialized;
      let at = this.busyUntil + delayMs;
      if (loss > 0 && random() < loss) {
        at += stallMs;
        this.stalledSegments++;
      }
      at = Math.max(at, state.lastArrival);
      state.lastArrival = at;
      const last = arrivals.at(-1);
      // Consecutive segments of one flow arriving together travel as one delivery.
      if (last && last.flow === flow && last.at === at && adjacent(last.bytes, segment.bytes))
        last.bytes = join(last.bytes, segment.bytes);
      else arrivals.push({ flow, bytes: segment.bytes, at });
    }
  }

  /** When the link can next start a segment, or undefined when nothing is queued. */
  wakeAt(): number | undefined {
    let earliest: number | undefined;
    for (const state of this.flows.values()) {
      const head = state.queue[0];
      if (!head) continue;
      const ready = Math.max(head.since, state.hold);
      if (earliest === undefined || ready < earliest) earliest = ready;
    }
    return earliest === undefined ? undefined : Math.max(this.busyUntil, earliest);
  }

  /** Bytes written on `flow` that have not yet left: its share of the bottleneck queue. */
  queued(flow: number): number {
    return this.flows.get(flow)?.queuedBytes ?? 0;
  }

  get stalls(): number {
    return this.stalledSegments;
  }

  /** The next flow in turn whose head segment may leave at `at`. */
  private nextFlow(at: number): number | undefined {
    for (let step = 0; step < this.order.length; step++) {
      const index = (this.turn + step) % this.order.length;
      const flow = this.order[index];
      const state = flow === undefined ? undefined : this.flows.get(flow);
      const head = state?.queue[0];
      if (!state || !head || Math.max(head.since, state.hold) > at) continue;
      this.turn = (index + 1) % this.order.length;
      return flow;
    }
    return undefined;
  }
}

/** Whether `b` continues `a` in the same underlying buffer. */
function adjacent(a: Uint8Array, b: Uint8Array): boolean {
  return a.buffer === b.buffer && a.byteOffset + a.length === b.byteOffset;
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.length + b.length);
}
