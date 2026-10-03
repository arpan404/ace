import type { PluginServerMessage } from "@ace/protocol/plugins";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import { WebSocket } from "ws";
import type { DeliveryEvent, ServerMessage } from "@ace/protocol";
import { WireEncoder } from "./wire-encoder.ts";

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
      last.payload.field === event.payload.field
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
  chargedBytes: number;
  subscriptionId: string;
  afterSeq: number;
  throughSeq: number;
  events: DeliveryEvent[];
}
export class Outbox {
  private pending: EventBatch[] = [];
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
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (message.type === "events" && this.socket.bufferedAmount > this.options.softLimit) {
      const charge = Buffer.byteLength(this.encoder.encode(message));
      if (!this.admit(charge)) return;
      const last = this.pending.at(-1);
      if (last?.subscriptionId === message.subscriptionId && last.throughSeq === message.afterSeq) {
        appendCoalesced(last.events, message.events);
        last.throughSeq = message.throughSeq;
        last.chargedBytes += charge;
      } else
        this.pending.push({
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
    // Reserve control/snapshot capacity before flushing, keeping ordering and the
    // same cap as queued events. hardLimit only governs how long pressure lasts.
    const encoded = this.encoder.encode(message);
    if (!this.admit(Buffer.byteLength(encoded))) return;
    this.flush();
    this.writeSerialized(encoded);
    this.tick();
  }
  private write(message: ServerMessage | PluginServerMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const encoded = this.encoder.encode(message);
    this.writeSerialized(encoded);
  }
  private writeSerialized(message: string): void {
    // A peer can stop reading while continuing to send requests. Every frame
    // reserves the same output capacity before handing bytes to ws.
    if (!this.admit(Buffer.byteLength(message))) return;
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(message, (error) => {
        if (error) this.socket.terminate();
      });
  }
  private admit(bytes: number): boolean {
    if (this.bytes + this.socket.bufferedAmount + bytes <= this.options.maxQueuedBytes) return true;
    this.resync();
    return false;
  }
  private flush(): void {
    const pending = this.pending;
    this.pending = [];
    for (const { chargedBytes, ...batch } of pending) {
      this.bytes -= chargedBytes;
      this.write({ type: "events", ...batch });
      if (this.socket.readyState !== WebSocket.OPEN) break;
    }
    this.bytes = 0;
  }
  tick(now = this.now()): void {
    if (this.socket.bufferedAmount > this.options.hardLimit) {
      this.aboveHardSince ??= now;
      if (now - this.aboveHardSince >= this.options.hardTimeoutMs) this.resync();
    } else this.aboveHardSince = undefined;
    if (this.socket.bufferedAmount <= this.options.softLimit) this.flush();
  }
  private resync(): void {
    this.pending = [];
    this.bytes = 0;
    this.socket.close(RESYNC_CLOSE_CODE, "Reconnect with afterSeq");
  }
  clear(): void {
    this.pending = [];
    this.bytes = 0;
  }
}
