import { ScreenFrameHeader, type ScreenLegacyFrameHeader } from "@ace/protocol";
export type Frame = {
  header: ScreenLegacyFrameHeader & {
    scale?: number;
    dirtyRects?: { x: number; y: number; w: number; h: number }[];
  };
  payload: Buffer;
  packet: Buffer;
};
export function framePacket(header: ScreenFrameHeader, payload: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(ScreenFrameHeader.parse(header)));
  if (payload.length !== header.bytes || json.length > 4096) throw new Error("Invalid frame size");
  const packet = Buffer.allocUnsafe(4 + json.length + payload.length);
  packet.writeUInt32BE(json.length);
  json.copy(packet, 4);
  payload.copy(packet, 4 + json.length);
  return packet;
}
/** Incremental fixed-size destinations avoid quadratic concatenation on fragmented input. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(4);
  private offset = 0;
  private phase: "length" | "header" | "payload" = "length";
  private header: Frame["header"] | undefined;
  private packet: Buffer | undefined;
  private readonly emit: (frame: Frame) => void;
  constructor(emit: (frame: Frame) => void) {
    this.emit = emit;
  }
  push(chunk: Buffer): void {
    let position = 0;
    while (position < chunk.length) {
      const count = Math.min(chunk.length - position, this.buffer.length - this.offset);
      chunk.copy(this.buffer, this.offset, position, position + count);
      position += count;
      this.offset += count;
      if (this.offset !== this.buffer.length) continue;
      this.offset = 0;
      if (this.phase === "length") {
        const length = this.buffer.readUInt32BE();
        if (length === 0 || length > 4096) throw new Error("Frame header exceeds limit");
        this.buffer = Buffer.allocUnsafe(length);
        this.phase = "header";
      } else if (this.phase === "header") {
        const wire = ScreenFrameHeader.parse(JSON.parse(this.buffer.toString("utf8")));
        this.header =
          wire.version === 1
            ? wire
            : {
                version: 1,
                sessionId: wire.sessionId,
                sequence: wire.seq,
                timestamp: wire.ts,
                width: wire.width,
                height: wire.height,
                codec: wire.codec,
                bytes: wire.bytes,
                scale: wire.scale,
                ...(wire.dirtyRects ? { dirtyRects: wire.dirtyRects } : {}),
              };
        const prefix = this.buffer;
        this.packet = Buffer.allocUnsafe(4 + prefix.length + wire.bytes);
        this.packet.writeUInt32BE(prefix.length);
        prefix.copy(this.packet, 4);
        this.buffer = this.packet.subarray(4 + prefix.length);
        this.phase = "payload";
      } else {
        const header = this.header;
        const packet = this.packet;
        if (!header || !packet) throw new Error("Missing frame header");
        const payload = this.buffer;
        this.buffer = Buffer.alloc(4);
        this.phase = "length";
        this.header = undefined;
        this.packet = undefined;
        this.emit({ header, payload, packet });
      }
    }
  }
  end(): void {
    if (this.phase !== "length" || this.offset !== 0) throw new Error("Truncated frame");
  }
}

export type FrameSink = (frame: Frame) => Promise<void>;
/** One in-flight frame and one replaceable pending frame per subscriber. */
export class FrameHub {
  private readonly subscribers = new Set<{
    send: FrameSink;
    busy: boolean;
    pending: Frame | undefined;
    active: boolean;
  }>();
  subscribe(send: FrameSink, initial?: Frame): () => void {
    if (this.subscribers.size >= 64) throw new Error("Subscriber limit");
    const subscriber = { send, busy: false, active: true, pending: undefined };
    this.subscribers.add(subscriber);
    if (initial) this.deliver(subscriber, initial);
    return () => {
      subscriber.active = false;
      subscriber.pending = undefined;
      this.subscribers.delete(subscriber);
    };
  }
  publish(frame: Frame): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.busy) subscriber.pending = frame;
      else this.deliver(subscriber, frame);
    }
  }
  clear(): void {
    for (const subscriber of this.subscribers) {
      subscriber.active = false;
      subscriber.pending = undefined;
    }
    this.subscribers.clear();
  }
  private deliver(
    subscriber: { send: FrameSink; busy: boolean; pending: Frame | undefined; active: boolean },
    frame: Frame,
  ): void {
    subscriber.busy = true;
    void Promise.resolve()
      .then(() => (subscriber.active ? subscriber.send(frame) : undefined))
      .then(
        () => {
          subscriber.busy = false;
          const pending = subscriber.pending;
          subscriber.pending = undefined;
          if (subscriber.active && pending) this.deliver(subscriber, pending);
        },
        () => {
          subscriber.active = false;
          subscriber.pending = undefined;
          this.subscribers.delete(subscriber);
        },
      );
  }
}
