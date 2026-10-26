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
 *
 * A refusal is kept while its device can still be admitted. Revoking a device deletes its
 * refusals (a trigger on `devices`), and one whose access ran out has its refusals deleted when
 * this machine starts: revocation and expiry are permanent, and admission checks the device is
 * still active in the same synchronous step as `find`, so no copy from that device can run later.
 */
export class MessageRejections {
  private store: Store;
  private now: () => number;
  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
    this.retire();
  }
  /** Deletes the refusals of devices that can never be admitted again. */
  private retire(): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "DELETE FROM machine_message_rejections WHERE NOT EXISTS(SELECT 1 FROM devices d WHERE d.id=device_id AND d.revoked_at IS NULL AND (d.expires_at IS NULL OR d.expires_at>?))",
        )
        .run(this.now()),
    );
  }
  /**
   * The device can still be admitted now: not revoked, its access not run out. A copy that
   * authenticated before its device was revoked fails here, before any refusal is consulted.
   */
  active(device: Device): boolean {
    return Boolean(
      this.store.atomic((db) =>
        db
          .prepare(
            "SELECT 1 FROM devices WHERE id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)",
          )
          .get(device.id, this.now()),
      ),
    );
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
    // A device that can't be admitted again needs no record: none of its copies can run.
    if (!this.active(device)) return new TargetRefusal("unauthorized");
    return this.store.atomic((db) => {
      const arrived = [`machine-message:${key}`, `machine-restart:${key}`].some((id) =>
        this.store.commandReceipt(CommandId.parse(id), device.id),
      );
      if (arrived)
        return new TargetRefusal("unavailable", "That message already reached it.", true);
      db.prepare(
        "INSERT OR IGNORE INTO machine_message_rejections (request_key,device_id,code,message) VALUES (?,?,?,?)",
      ).run(key, device.id, refusal.code, refusal.message);
      return this.find(key) ?? new TargetRefusal(refusal.code, refusal.message, true);
    });
  }
}
