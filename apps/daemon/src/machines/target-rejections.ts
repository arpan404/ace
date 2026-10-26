import { createHash } from "node:crypto";
import { z } from "zod";
import { CommandId, MachineRefusal, type Device, type MachineCall } from "@ace/protocol";
import type { Store } from "../store.ts";
import { TargetRefusal } from "./target-refusal.ts";

type Message = Extract<MachineCall, { op: "message" }>;
const Saved = z.object({ code: MachineRefusal.shape.error, message: z.string() });

/** The key every step of one message request is recorded under: device, thread and request. */
export function messageKey(device: Device, call: Message): string {
  return createHash("sha256")
    .update(JSON.stringify([device.id, call.threadId, call.requestId]))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Messages this machine refused before they ever reached their thread: its access check, its
 * ownership check, or a deleted thread (ADR 0099). The refusal is saved under the request's key
 * and checked before any copy of that request is admitted, so a refused request never runs, not
 * even a copy still on its way. That lets every refusal answer for the request (final), and the
 * calling machine stop waiting on it.
 */
export class MessageRejections {
  private store: Store;
  private now: () => number;
  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }
  /** The saved refusal for this request, which every later copy gets. */
  find(key: string): TargetRefusal | undefined {
    const row = this.store.atomic((db) =>
      db
        .prepare("SELECT code,message FROM machine_message_rejections WHERE request_key=?")
        .get(key),
    );
    if (!row) return undefined;
    const saved = Saved.parse(row);
    return new TargetRefusal(saved.code, saved.message, true);
  }
  /**
   * Refuses the request for good with `refusal`, unless a copy already reached the thread: then
   * that copy's fate stands and this answer only says so. Runs in one step with the check, and
   * admission checks `find` first, so the two never interleave.
   */
  reject(device: Device, call: Message, refusal: TargetRefusal): TargetRefusal {
    const key = messageKey(device, call);
    return this.store.atomic((db) => {
      const arrived = [`machine-message:${key}`, `machine-restart:${key}`].some((id) =>
        this.store.commandReceipt(CommandId.parse(id), device.id),
      );
      if (arrived)
        return new TargetRefusal("unavailable", "That message already reached it.", true);
      db.prepare("INSERT OR IGNORE INTO machine_message_rejections VALUES (?,?,?,?)").run(
        key,
        refusal.code,
        refusal.message,
        this.now(),
      );
      return this.find(key) ?? new TargetRefusal(refusal.code, refusal.message, true);
    });
  }
}
