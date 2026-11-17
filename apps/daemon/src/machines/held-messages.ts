import { z } from "zod";
import { MachineCall } from "@ace/protocol";
import type { Store } from "../store.ts";

type Message = Extract<MachineCall, { op: "message" }>;
const Row = z.object({ request_key: z.string(), device_id: z.string(), call: z.string() });

/** A message another machine sent while admission here was closed, kept to deliver later. */
export interface HeldMessage {
  key: string;
  deviceId: string;
  call: Message;
}

/**
 * The most held messages may take, per paired device and across all of them, by count and by
 * their stored bytes. A long pause or storage hold can't let callers fill the database.
 */
export interface HeldLimits {
  perDevice: { count: number; bytes: number };
  total: { count: number; bytes: number };
}
export const heldLimits: HeldLimits = {
  perDevice: { count: 64, bytes: 2 * 1024 * 1024 },
  total: { count: 512, bytes: 16 * 1024 * 1024 },
};

/**
 * Messages from other machines' agents that arrived while this machine held new work (a pause,
 * an update, a full disk; ADR 0041, 0176). Each is kept once under its request key, so a retried
 * copy is the same message, and is delivered in arrival order once admission reopens. Durable:
 * a restart while held keeps them.
 */
export class HeldMessages {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS machine_held_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, request_key TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL, thread_id TEXT NOT NULL, call TEXT NOT NULL)`),
    );
  }
  /**
   * Keeps `call` to deliver later; a copy of one already kept changes nothing. "full" when it
   * would pass the device's or the machine's budget (`heldLimits`), and nothing is kept.
   */
  hold(
    key: string,
    deviceId: string,
    call: Message,
    limits: HeldLimits = heldLimits,
  ): "held" | "full" {
    const text = JSON.stringify(call);
    const bytes = Buffer.byteLength(text);
    const over = (now: { count: number; bytes: number }, limit: { count: number; bytes: number }) =>
      now.count + 1 > limit.count || now.bytes + bytes > limit.bytes;
    return this.store.atomic((db) => {
      if (db.prepare("SELECT 1 FROM machine_held_messages WHERE request_key=?").get(key))
        return "held";
      const used = (where: string, ...args: string[]) => {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS n, COALESCE(SUM(length(CAST(call AS BLOB))),0) AS bytes FROM machine_held_messages ${where}`,
          )
          .get(...args);
        return { count: Number(row?.n), bytes: Number(row?.bytes) };
      };
      if (over(used("WHERE device_id=?", deviceId), limits.perDevice)) return "full";
      if (over(used(""), limits.total)) return "full";
      db.prepare(
        "INSERT INTO machine_held_messages (request_key,device_id,thread_id,call) VALUES (?,?,?,?)",
      ).run(key, deviceId, call.threadId, text);
      return "held";
    });
  }
  /** Drops what was held for a thread that is deleted: its text is not kept past it. */
  forget(threadId: string): void {
    this.store.atomic((db) =>
      db.prepare("DELETE FROM machine_held_messages WHERE thread_id=?").run(threadId),
    );
  }
  /** Whether anything waits to be delivered: to `threadId`, or to any thread. */
  waiting(threadId?: string): boolean {
    return Boolean(
      this.store.atomic((db) =>
        threadId === undefined
          ? db.prepare("SELECT 1 FROM machine_held_messages LIMIT 1").get()
          : db
              .prepare("SELECT 1 FROM machine_held_messages WHERE thread_id=? LIMIT 1")
              .get(threadId),
      ),
    );
  }
  /** The oldest held messages, in the order they arrived. */
  oldest(limit = 32): HeldMessage[] {
    return this.store.atomic((db) =>
      db
        .prepare(
          "SELECT request_key,device_id,call FROM machine_held_messages ORDER BY seq LIMIT ?",
        )
        .all(limit)
        .map((raw) => {
          const row = Row.parse(raw);
          const call = MachineCall.parse(JSON.parse(row.call));
          if (call.op !== "message") throw new Error("A held machine call is not a message");
          return { key: row.request_key, deviceId: row.device_id, call };
        }),
    );
  }
  remove(key: string): void {
    this.store.atomic((db) =>
      db.prepare("DELETE FROM machine_held_messages WHERE request_key=?").run(key),
    );
  }
}
