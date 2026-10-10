import { ScreenFrameHeader } from "@ace/protocol";

export interface PortableFrame {
  header: ScreenFrameHeader;
  payload: Uint8Array<ArrayBuffer>;
  /** Original wire packet; payload is a view into the same allocation. */
  packet: Uint8Array<ArrayBuffer>;
}
/** Portable screen framing for browser, desktop and native relay consumers. */
export class ScreenFrameReader {
  private destination = new Uint8Array(4);
  private offset = 0;
  private phase: "length" | "header" | "payload" = "length";
  private header: ScreenFrameHeader | undefined;
  private packet: Uint8Array<ArrayBuffer> | undefined;
  private readonly emit: (frame: PortableFrame) => void;
  private readonly text = new TextDecoder("utf-8", { fatal: true });
  constructor(emit: (frame: PortableFrame) => void) {
    this.emit = emit;
  }
  push(chunk: Uint8Array): void {
    let position = 0;
    while (position < chunk.byteLength) {
      const count = Math.min(
        chunk.byteLength - position,
        this.destination.byteLength - this.offset,
      );
      this.destination.set(chunk.subarray(position, position + count), this.offset);
      this.offset += count;
      position += count;
      if (this.offset !== this.destination.byteLength) continue;
      this.offset = 0;
      if (this.phase === "length") {
        const length = new DataView(this.destination.buffer).getUint32(0);
        if (length === 0 || length > 4096) throw new Error("Frame header exceeds limit");
        this.destination = new Uint8Array(length);
        this.phase = "header";
      } else if (this.phase === "header") {
        const raw: unknown = JSON.parse(this.text.decode(this.destination));
        this.header = ScreenFrameHeader.parse(raw);
        const prefix = this.destination;
        this.packet = new Uint8Array(4 + prefix.byteLength + this.header.bytes);
        new DataView(this.packet.buffer).setUint32(0, prefix.byteLength);
        this.packet.set(prefix, 4);
        this.destination = this.packet.subarray(4 + prefix.byteLength);
        this.phase = "payload";
      } else {
        const header = this.header;
        const payload = this.destination;
        const packet = this.packet;
        if (!header || !packet) throw new Error("Missing frame header");
        this.reset();
        this.emit({ header, payload, packet });
      }
    }
  }
  reset(): void {
    this.destination = new Uint8Array(4);
    this.offset = 0;
    this.header = undefined;
    this.packet = undefined;
    this.phase = "length";
  }
  end(): void {
    if (this.phase !== "length" || this.offset !== 0) throw new Error("Truncated frame");
  }
}

export type LatestFrameSink<T> = (frame: T) => Promise<void>;
type Subscriber<T> = {
  send: LatestFrameSink<T>;
  busy: boolean;
  pending: T | undefined;
  active: boolean;
};
/** One in-flight item and one replaceable pending item per consumer, no history. */
export class LatestFrameHub<T> {
  private readonly subscribers = new Set<Subscriber<T>>();
  subscribe(send: LatestFrameSink<T>, initial?: T): () => void {
    if (this.subscribers.size >= 64) throw new Error("Subscriber limit");
    const subscriber: Subscriber<T> = { send, busy: false, active: true, pending: undefined };
    this.subscribers.add(subscriber);
    if (initial !== undefined) this.deliver(subscriber, initial);
    return () => {
      subscriber.active = false;
      subscriber.pending = undefined;
      this.subscribers.delete(subscriber);
    };
  }
  publish(frame: T): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.busy) subscriber.pending = frame;
      else this.deliver(subscriber, frame);
    }
  }
  /** Invalidate queued frames without removing the mounted consumers. */
  discardPending(): void {
    for (const subscriber of this.subscribers) subscriber.pending = undefined;
  }
  clear(): void {
    for (const subscriber of this.subscribers) {
      subscriber.active = false;
      subscriber.pending = undefined;
    }
    this.subscribers.clear();
  }
  private deliver(subscriber: Subscriber<T>, frame: T): void {
    subscriber.busy = true;
    void Promise.resolve()
      .then(() => (subscriber.active ? subscriber.send(frame) : undefined))
      .then(
        () => {
          subscriber.busy = false;
          const pending = subscriber.pending;
          subscriber.pending = undefined;
          if (subscriber.active && pending !== undefined) this.deliver(subscriber, pending);
        },
        () => {
          subscriber.active = false;
          subscriber.pending = undefined;
          this.subscribers.delete(subscriber);
        },
      );
  }
}

/**
 * Live-view streams one connection has asked the daemon for, one per target however many views
 * show it. The daemon keeps one stream per target per connection, so a second subscribe is
 * wasted and the first view's unsubscribe would cut the others. `retain` opens a target's
 * stream for its first view and closes it after its last; `reset` (a new connection) forgets
 * them all, and releases held from before it do nothing.
 */
export class SharedStreams {
  private readonly views = new Map<string, number>();
  private generation = 0;
  retain(target: string, open: () => void, close: () => void): () => void {
    const count = this.views.get(target) ?? 0;
    this.views.set(target, count + 1);
    if (count === 0) open();
    const generation = this.generation;
    let held = true;
    return () => {
      if (!held || generation !== this.generation) return;
      held = false;
      const left = (this.views.get(target) ?? 1) - 1;
      if (left > 0) return void this.views.set(target, left);
      this.views.delete(target);
      close();
    };
  }
  /** A replacement native capture needs a subscription even if its view stayed mounted. */
  refresh(target: string, open: () => void): void {
    if (this.views.has(target)) open();
  }
  reset(): void {
    this.generation++;
    this.views.clear();
  }
}
