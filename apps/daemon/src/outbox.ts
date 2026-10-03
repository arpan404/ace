import type { PluginServerMessage } from "@ace/protocol/plugins";
import { systemDeliveryRuntime } from "./delivery-runtime.ts";
import { WebSocket } from "ws";
import type { DeliveryEvent, ServerMessage } from "@ace/protocol";

export const RESYNC_CLOSE_CODE = 4009;
export interface PressureOptions {
  softLimit: number;
  hardLimit: number;
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
  constructor(socket: WebSocket, options: PressureOptions, now = systemDeliveryRuntime.now) {
    this.now = now;
    this.socket = socket;
    this.options = options;
  }
  send(message: ServerMessage | PluginServerMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (message.type === "events" && this.socket.bufferedAmount > this.options.softLimit) {
      const last = this.pending.at(-1);
      if (last?.subscriptionId === message.subscriptionId && last.throughSeq === message.afterSeq) {
        appendCoalesced(last.events, message.events);
        last.throughSeq = message.throughSeq;
      } else
        this.pending.push({
          subscriptionId: message.subscriptionId,
          afterSeq: message.afterSeq,
          throughSeq: message.throughSeq,
          events: coalesceEvents(message.events),
        });
      this.bytes += Buffer.byteLength(JSON.stringify(message));
      if (this.bytes > this.options.maxQueuedBytes) this.resync();
      this.tick();
      return;
    }
    // Admit the whole snapshot before handing any of its bytes to the transport.
    // This caps transport bytes; bounding status allocation needs snapshot paging.
    if (message.type === "snapshot") {
      const serialized = JSON.stringify(message);
      if (
        this.bytes + this.socket.bufferedAmount + Buffer.byteLength(serialized) >
        this.options.maxQueuedBytes
      ) {
        this.resync();
        return;
      }
      this.flush();
      this.writeSerialized(serialized);
      this.tick();
      return;
    }
    // Control messages retain ordering relative to queued event batches.
    this.flush();
    this.write(message);
    this.tick();
  }
  private write(message: ServerMessage | PluginServerMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const encoded = JSON.stringify(message);
    if (
      message.type.startsWith("settings.") &&
      this.socket.bufferedAmount + Buffer.byteLength(encoded) > this.options.hardLimit
    ) {
      this.resync();
      return;
    }
    this.writeSerialized(encoded);
  }
  private writeSerialized(message: string): void {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(message, (error) => {
        if (error) this.socket.terminate();
      });
  }
  private flush(): void {
    const pending = this.pending;
    this.pending = [];
    this.bytes = 0;
    for (const batch of pending) this.write({ type: "events", ...batch });
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
