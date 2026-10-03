import { z } from "zod";
import type { Frame } from "@ace/engine-api";
import { object, string, list, type Data } from "./native.ts";
import type { ClaudeState } from "./state.ts";

const receipt = z.object({ still_queued: z.array(z.string()).max(4096) }).passthrough();
/** UUID receipts describe only main-thread sends. Never infer task completion from them. */
export class NativeQueue {
  private readonly sent = new Set<string>();
  private readonly survivors = new Set<string>();
  private readonly interrupts = new Set<string>();
  private receiptSupported: boolean | undefined;
  private overflow = false;
  observe(state: ClaudeState, frame: Frame, data: Data): void {
    const type = string(data["type"]);
    if (type === "system" && data["subtype"] === "init") {
      this.receiptSupported = list(data["capabilities"]).includes("interrupt_receipt_v1");
      if (!this.receiptSupported) {
        this.sent.clear();
        this.retireOverflow(state);
      }
    }
    if (frame.dir === "send" && type === "user" && this.receiptSupported !== false) {
      const uuid = string(data["uuid"]);
      if (uuid) this.sent.add(uuid);
      // Overflow must hold status uncertain rather than silently discard possible work.
      if (this.sent.size > 256) {
        this.sent.delete(this.sent.values().next().value ?? "");
        if (!this.overflow) {
          this.overflow = true;
          state.emit({
            type: "background.started",
            agent: state.root,
            task: state.key("queue-correlation", "overflow"),
            kind: "other",
            title: "Claude queued work cannot be fully correlated",
            stoppable: false,
          });
        }
      }
    }
    if (
      type === "control_request" &&
      frame.dir === "send" &&
      object(data["request"])["subtype"] === "interrupt"
    ) {
      if (this.interrupts.size >= 64)
        this.interrupts.delete(this.interrupts.values().next().value ?? "");
      this.interrupts.add(string(data["request_id"]));
    }
    if (type === "control_response" && frame.dir === "recv") {
      const response = object(data["response"]);
      if (this.interrupts.delete(string(response["request_id"])) && this.receiptSupported) {
        const parsed = receipt.safeParse(response["response"]);
        if (parsed.success) {
          this.survivors.clear();
          for (const uuid of parsed.data.still_queued)
            if (this.sent.has(uuid)) this.survivors.add(uuid);
          this.publish(state, this.survivors.size);
        }
      }
    }
    if (type === "result" && frame.dir === "recv") {
      let consumedSurvivor = false;
      for (const uuid of [...list(data["user_message_uuids"]), data["user_message_uuid"]])
        if (typeof uuid === "string") {
          this.sent.delete(uuid);
          consumedSurvivor = this.survivors.delete(uuid) || consumedSurvivor;
        }
      const queued = data["queued_turn_count"];
      if (typeof queued === "number" && Number.isSafeInteger(queued) && queued >= 0) {
        // A completed turn with an authoritative empty native queue retires lost correlations,
        // including producers that never echo consumed UUIDs. Background work is independent.
        if (queued === 0) {
          this.sent.clear();
          this.survivors.clear();
          this.retireOverflow(state);
        }
        this.publish(state, Math.max(queued, this.survivors.size));
      } else if (consumedSurvivor || this.survivors.size) this.publish(state, this.survivors.size);
    }
  }
  private retireOverflow(state: ClaudeState): void {
    if (!this.overflow) return;
    this.overflow = false;
    state.emit({
      type: "background.ended",
      task: state.key("queue-correlation", "overflow"),
      status: "completed",
    });
  }
  private publish(state: ClaudeState, count: number): void {
    if (state.nativeQueued === count) return;
    state.nativeQueued = count;
    state.emit({ type: "queue.changed", count, source: "provider" });
  }
}
