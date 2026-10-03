import { fitsUtf8 } from "./bounds.ts";
import { z } from "zod";
import { Command, CommandResult, type CommandPayload, type DeviceId } from "@ace/protocol";
import { ClientError, type Storage } from "./types.ts";

const Intent = z.object({
  command: Command,
  state: z.enum(["pending", "acked", "failed"]),
  error: z.string().optional(),
});
export type Intent = z.infer<typeof Intent>;
/** A transient refusal (update drain, rolled-back transaction) is retried this many times. */
const maxRetries = 10;
export class Intents {
  private records = new Map<string, Intent>();
  private storage: Storage;
  private device: DeviceId;
  private limit: number;
  private operations = 0;
  private acknowledging = new Set<string>();
  private bytes: number;
  private frameBytes: number;
  private chain: Promise<void> = Promise.resolve();
  private changed: (id: string) => void;
  private send: (command: Command) => void;
  private retryAfter: (attempt: number, run: () => void) => () => void;
  private retries = new Map<string, { attempt: number; cancel: (() => void) | undefined }>();
  private ready = false;
  private initializing: Promise<void> | undefined;
  constructor(
    storage: Storage,
    device: DeviceId,
    limit: number,
    bytes: number,
    frameBytes: number,
    changed: (id: string) => void,
    send: (command: Command) => void,
    retryAfter: (attempt: number, run: () => void) => () => void,
  ) {
    this.retryAfter = retryAfter;
    this.storage = storage;
    this.device = device;
    this.limit = limit;
    this.bytes = bytes;
    this.frameBytes = frameBytes;
    this.changed = changed;
    this.send = send;
  }
  initialize(): Promise<void> {
    this.initializing ??= (async () => {
      try {
        const raw = await this.storage.load();
        if (raw !== null && !fitsUtf8(raw, this.bytes)) throw new ClientError("limit");
        const records = z
          .array(Intent)
          .max(this.limit)
          .parse(raw === null ? [] : JSON.parse(raw));
        for (const intent of records) {
          if (intent.command.deviceId !== this.device || this.records.has(intent.command.id))
            throw new Error("Outbox identity mismatch");
          this.records.set(intent.command.id, intent);
        }
        this.ready = true;
      } catch {
        throw new ClientError("storage");
      }
    })();
    return this.initializing;
  }
  get(id: string): Intent | undefined {
    return this.records.get(id);
  }
  private serialize(run: () => Promise<void>): Promise<void> {
    if (this.operations >= this.limit * 2) return Promise.reject(new ClientError("limit"));
    this.operations++;
    const result = this.chain.then(run).finally(() => {
      this.operations--;
    });
    this.chain = result.catch(() => {});
    return result;
  }
  enqueue(id: string, payload: CommandPayload): Promise<void> {
    return this.serialize(async () => {
      if (!this.ready) throw new ClientError("storage");
      const command = Command.parse({ id, deviceId: this.device, payload });
      if (!fitsUtf8(JSON.stringify({ type: "command", command }), this.frameBytes))
        throw new ClientError("limit");
      const existing = this.records.get(id);
      if (existing) {
        if (JSON.stringify(existing.command) !== JSON.stringify(command))
          throw new ClientError("protocol", "Idempotency key reused with different payload");
        this.send(existing.command);
        return;
      }
      let evicted: string | undefined;
      if (this.records.size >= this.limit) {
        const evict = [...this.records].find(([, intent]) => intent.state !== "pending");
        if (!evict) throw new ClientError("limit");
        evicted = evict[0];
      }
      const intent: Intent = { command, state: "pending" };
      const next = [...this.records.values()]
        .filter((record) => record.command.id !== evicted)
        .concat(intent);
      const serialized = JSON.stringify(next);
      if (!fitsUtf8(serialized, this.bytes)) throw new ClientError("limit");
      try {
        await this.storage.save(serialized);
      } catch {
        throw new ClientError("storage");
      }
      if (evicted) {
        this.records.delete(evicted);
        this.changed(evicted);
      }
      this.records.set(id, intent);
      this.changed(id);
      this.send(command);
    });
  }
  /** A daemon refusal of one command. Transient ones stay pending and resend with backoff. */
  refuse(commandId: string, code: string, retryable: boolean): Promise<void> {
    const intent = this.records.get(commandId);
    if (intent?.state !== "pending") return Promise.resolve();
    const retry = this.retries.get(commandId) ?? { attempt: 0, cancel: undefined };
    if (!retryable || retry.attempt >= maxRetries)
      return this.acknowledge({ commandId: intent.command.id, ok: false, error: code });
    retry.cancel?.();
    retry.cancel = this.retryAfter(retry.attempt++, () => {
      retry.cancel = undefined;
      if (this.records.get(commandId)?.state === "pending") this.send(intent.command);
    });
    this.retries.set(commandId, retry);
    return Promise.resolve();
  }
  acknowledge(result: CommandResult): Promise<void> {
    this.retries.get(result.commandId)?.cancel?.();
    this.retries.delete(result.commandId);
    if (
      this.acknowledging.has(result.commandId) ||
      this.records.get(result.commandId)?.state !== "pending"
    )
      return Promise.resolve();
    this.acknowledging.add(result.commandId);
    return this.serialize(async () => {
      const previous = this.records.get(result.commandId);
      if (!previous || previous.state !== "pending") return;
      const next: Intent = {
        command: previous.command,
        state: result.ok ? "acked" : "failed",
        ...(result.error === undefined ? {} : { error: result.error }),
      };
      const serialized = JSON.stringify(
        [...this.records.values()].map((intent) => (intent === previous ? next : intent)),
      );
      if (!fitsUtf8(serialized, this.bytes)) throw new ClientError("storage");
      try {
        await this.storage.save(serialized);
      } catch {
        throw new ClientError("storage");
      }
      this.records.set(result.commandId, next);
      this.changed(result.commandId);
    }).finally(() => {
      this.acknowledging.delete(result.commandId);
    });
  }
  settled(): Promise<void> {
    return this.chain;
  }
  replay(): void {
    // Replay resends every pending intent; a scheduled retry would only duplicate it.
    for (const retry of this.retries.values()) {
      retry.cancel?.();
      retry.cancel = undefined;
    }
    for (const intent of this.records.values())
      if (intent.state === "pending") this.send(intent.command);
  }
}
