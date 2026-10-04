import type { PluginServerMessage } from "@ace/protocol/plugins";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import { WebSocket } from "ws";
import type { DeliveryEvent, ServerMessage } from "@ace/protocol";
import { WireEncoder, eventFrameBytes } from "./wire-encoder.ts";

export const RESYNC_CLOSE_CODE = 4009;
export interface PressureOptions {
  softLimit: number;
  /** Sustained transport pressure threshold; not the absolute memory admission cap. */
  hardLimit: number;
  /** Absolute queued + transport byte cap, shared by every outbound frame type. */
  maxQueuedBytes: number;
  hardTimeoutMs: number;
}
export const defaultPressure: PressureOptions = {
  softLimit: 256 * 1024,
  hardLimit: 4 * 1024 * 1024,
  maxQueuedBytes: 4 * 1024 * 1024,
  hardTimeoutMs: 5000,
};
export function coalesceEvents(events: DeliveryEvent[]): DeliveryEvent[] {
  const result: DeliveryEvent[] = [];
  appendCoalesced(result, events);
  return result;
}
function appendCoalesced(result: DeliveryEvent[], events: DeliveryEvent[]): void {
  for (const event of events) {
    const last = result.at(-1);
    if (
      last &&
      last.payload.type === "item.delta" &&
      event.payload.type === "item.delta" &&
      last.seq + 1 === (event.firstSeq ?? event.seq) &&
      last.threadId === event.threadId &&
      last.payload.itemId === event.payload.itemId &&
      last.payload.agentId === event.payload.agentId &&
      last.payload.field === event.payload.field &&
      last.payload.append.length + event.payload.append.length <= 65536
    ) {
      result[result.length - 1] = {
        ...event,
        firstSeq: last.firstSeq ?? last.seq,
        payload: { ...event.payload, append: last.payload.append + event.payload.append },
      };
    } else result.push(event);
  }
}
interface EventBatch {
  type: "events";
  chargedBytes: number;
  subscriptionId: string;
  afterSeq: number;
  throughSeq: number;
  events: DeliveryEvent[];
}
interface SerializedFrame {
  type: "serialized";
  chargedBytes: number;
  encoded: string;
  snapshotId: string | undefined;
}
interface SnapshotStream {
  type: "snapshot";
  chargedBytes: 0;
  encoded: string;
  subscriptionId: string;
  seq: number;
  offset: number;
  index: number;
}
type PendingFrame = EventBatch | SerializedFrame | SnapshotStream;
export class Outbox {
  private pending = new Map<number, PendingFrame>();
  private snapshots = new Map<string, number>();
  private tail = 0;
  private bytes = 0;
  private aboveHardSince: number | undefined;
  private options: PressureOptions;
  private socket: WebSocket;
  private now: () => number;
  private encoder: WireEncoder;
  constructor(
    socket: WebSocket,
    options: PressureOptions,
    now = systemDeliveryRuntime.now,
    encoder = new WireEncoder(),
  ) {
    this.now = now;
    this.socket = socket;
    this.options = options;
    this.encoder = encoder;
  }
  send(message: ServerMessage | PluginServerMessage): void {
    if (message.type === "events") {
      for (const frame of this.encoder.split(message)) this.sendOne(frame);
    } else if (message.type === "snapshot") {
      const encoded = this.encoder.encode(message);
      if (Buffer.byteLength(encoded) <= eventFrameBytes) this.sendOne(message);
      else {
        // The active-entity source may exceed the queue budget. Produce only the next
        // fragment when transport drains; serialized fragments share the admission cap.
        this.pending.set(++this.tail, {
          type: "snapshot",
          chargedBytes: 0,
          encoded,
          subscriptionId: message.subscriptionId,
          seq: message.seq,
          offset: 0,
          index: 0,
        });
        this.flush();
        this.tick();
      }
    } else this.sendOne(message);
  }
  private sendOne(message: ServerMessage | PluginServerMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (message.type === "events" && this.socket.bufferedAmount > this.options.softLimit) {
      const charge = Buffer.byteLength(this.encoder.encode(message));
      if (charge > eventFrameBytes) {
        this.resync();
        return;
      }
      if (!this.admit(charge)) return;
      const last = this.pending.get(this.tail);
      if (
        last?.type === "events" &&
        last.subscriptionId === message.subscriptionId &&
        last.throughSeq === message.afterSeq &&
        last.chargedBytes + charge <= eventFrameBytes
      ) {
        appendCoalesced(last.events, message.events);
        last.throughSeq = message.throughSeq;
        last.chargedBytes += charge;
      } else
        this.pending.set(++this.tail, {
          type: "events",
          chargedBytes: charge,
          subscriptionId: message.subscriptionId,
          afterSeq: message.afterSeq,
          throughSeq: message.throughSeq,
          events: coalesceEvents(message.events),
        });
      this.bytes += charge;
      this.tick();
      return;
    }
    const encoded = this.encoder.encode(message);
    const charge = Buffer.byteLength(encoded);
    if (charge > eventFrameBytes) {
      this.resync();
      return;
    }
    // Conductor changes are complete replaceable views. Keep only the latest
    // unsent view per subscription, after any intervening replies/events.
    const snapshotId = message.type === "conductor.changed" ? message.subscriptionId : undefined;
    if (snapshotId !== undefined) {
      const index = this.snapshots.get(snapshotId);
      const previous = index === undefined ? undefined : this.pending.get(index);
      if (previous && index !== undefined) {
        this.pending.delete(index);
        this.bytes -= previous.chargedBytes;
      }
    }
    if (!this.admit(charge)) return;
    this.pending.set(++this.tail, {
      type: "serialized",
      encoded,
      chargedBytes: charge,
      snapshotId,
    });
    if (snapshotId !== undefined) this.snapshots.set(snapshotId, this.tail);
    this.bytes += charge;
    this.flush();
    this.tick();
  }
  private admit(bytes: number): boolean {
    if (this.bytes + this.socket.bufferedAmount + bytes <= this.options.maxQueuedBytes) return true;
    this.resync();
    return false;
  }
  private flush(): void {
    // Stop handing frames to ws while transport is congested. The send callback
    // resumes delivery after real I/O, rather than filling ws with a synchronous
    // burst of full snapshots. Pending bytes and ws bytes share one admission cap.
    while (
      this.pending.size &&
      this.socket.readyState === WebSocket.OPEN &&
      this.socket.bufferedAmount <= Math.max(0, this.options.softLimit)
    ) {
      const entry = this.pending.entries().next().value;
      if (!entry) break;
      const [index, frame] = entry;
      if (frame.type !== "snapshot") this.pending.delete(index);
      if (frame.type === "serialized" && frame.snapshotId !== undefined)
        this.snapshots.delete(frame.snapshotId);
      this.bytes -= frame.chargedBytes;
      let encoded: string;
      if (frame.type === "snapshot") {
        const end = frame.offset + 131072;
        encoded = this.encoder.encode({
          type: "snapshot.part",
          subscriptionId: frame.subscriptionId,
          seq: frame.seq,
          index: frame.index++,
          done: end >= frame.encoded.length,
          data: frame.encoded.slice(frame.offset, end),
        });
        frame.offset = end;
        if (end >= frame.encoded.length) this.pending.delete(index);
      } else
        encoded =
          frame.type === "serialized"
            ? frame.encoded
            : this.encoder.encode({
                type: "events",
                subscriptionId: frame.subscriptionId,
                afterSeq: frame.afterSeq,
                throughSeq: frame.throughSeq,
                events: frame.events,
              });
      if (Buffer.byteLength(encoded) > eventFrameBytes) {
        this.resync();
        return;
      }
      if (!this.admit(Buffer.byteLength(encoded))) return;
      this.socket.send(encoded, (error) => {
        if (error) this.socket.terminate();
        else this.flush();
      });
    }
  }
  tick(now = this.now()): void {
    if (this.socket.bufferedAmount > this.options.hardLimit) {
      this.aboveHardSince ??= now;
      if (now - this.aboveHardSince >= this.options.hardTimeoutMs) this.resync();
    } else this.aboveHardSince = undefined;
    if (this.socket.bufferedAmount <= this.options.softLimit) this.flush();
  }
  private resync(): void {
    this.pending.clear();
    this.snapshots.clear();
    this.bytes = 0;
    this.tail = 0;
    this.socket.close(RESYNC_CLOSE_CODE, "Reconnect with afterSeq");
  }
  clear(): void {
    this.pending.clear();
    this.snapshots.clear();
    this.bytes = 0;
    this.tail = 0;
  }
}
