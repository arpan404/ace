/**
 * One direction of a shaped link, as pure arithmetic on times: no sockets, no timers. Bytes
 * written at `now` are cut into segments; each leaves when the bottleneck is free, takes
 * `size / rate` to serialize, then the one-way delay to arrive. A lost segment arrives one stall
 * later, and TCP delivers in order, so nothing after it arrives sooner. The shaper
 * (link-shaper.ts) turns the arrival times into timers.
 */
export interface LinkPipeOptions {
  /** `null` serializes instantly. */
  bitsPerSecond: number | null;
  delayMs: number;
  loss: number;
  stallMs: number;
  random: () => number;
  /** TCP's maximum segment size on a 1500-byte path. */
  segmentBytes?: number;
}

/** A run of a written chunk that arrives together at `at`. */
export interface Arrival {
  start: number;
  end: number;
  at: number;
}

export class LinkPipe {
  private busyUntil = 0;
  private lastArrival = 0;
  private stalledSegments = 0;
  private readonly segment: number;
  private readonly options: LinkPipeOptions;

  constructor(options: LinkPipeOptions) {
    this.options = options;
    this.segment = options.segmentBytes ?? 1460;
  }

  /** Nothing leaves before `at`: a new connection's first data waits out the TCP handshake. */
  holdUntil(at: number): void {
    this.busyUntil = Math.max(this.busyUntil, at);
  }

  /** When each part of a `length`-byte chunk written at `now` reaches the other end. */
  send(now: number, length: number): Arrival[] {
    const { bitsPerSecond, delayMs, loss, stallMs, random } = this.options;
    // Unshaped and lossless: one arrival, no segments to model.
    if (bitsPerSecond === null && loss === 0) {
      const at = Math.max(Math.max(now, this.busyUntil) + delayMs, this.lastArrival);
      this.lastArrival = at;
      return [{ start: 0, end: length, at }];
    }
    const arrivals: Arrival[] = [];
    for (let start = 0; start < length; start += this.segment) {
      const end = Math.min(length, start + this.segment);
      const leaves = Math.max(now, this.busyUntil);
      const serialized = bitsPerSecond === null ? 0 : ((end - start) * 8 * 1000) / bitsPerSecond;
      this.busyUntil = leaves + serialized;
      let at = this.busyUntil + delayMs;
      if (loss > 0 && random() < loss) {
        at += stallMs;
        this.stalledSegments++;
      }
      at = Math.max(at, this.lastArrival);
      this.lastArrival = at;
      const previous = arrivals.at(-1);
      if (previous && previous.at === at) previous.end = end;
      else arrivals.push({ start, end, at });
    }
    return arrivals;
  }

  /** Bytes written but still waiting for the bottleneck at `now`. */
  queued(now: number): number {
    const { bitsPerSecond } = this.options;
    if (bitsPerSecond === null) return 0;
    return Math.max(0, ((this.busyUntil - now) * bitsPerSecond) / 8 / 1000);
  }

  /** When the bottleneck queue will have drained down to `bytes`. */
  drainsTo(bytes: number): number {
    const { bitsPerSecond } = this.options;
    if (bitsPerSecond === null) return 0;
    return this.busyUntil - (bytes * 8 * 1000) / bitsPerSecond;
  }

  /** When the last byte written so far arrives. */
  get drainedAt(): number {
    return this.lastArrival;
  }

  get stalls(): number {
    return this.stalledSegments;
  }
}
