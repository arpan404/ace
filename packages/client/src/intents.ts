import { fitsUtf8 } from "./bounds.ts";
import { z } from "zod";
import { Command, CommandResult, type CommandPayload, type DeviceId } from "@ace/protocol";
import { ClientError, type Storage } from "./types.ts";

const Intent = z.object({
  command: Command,
  state: z.enum(["saving", "pending", "acked", "failed"]),
  error: z.string().optional(),
  delivered: z.boolean().optional(),
  threadId: z.string().optional(),
  sent: z.boolean().optional(),
  waiting: z.boolean().optional(),
  localFailure: z.boolean().optional(),
});
export type Intent = z.infer<typeof Intent>;
/** A transient refusal (update drain, rolled-back transaction) is retried this many times. */
const maxRetries = 10;
export class Intents {
  private records = new Map<string, Intent>();
  private optimistic = new Map<string, Intent>();
  private enqueuing = new Map<string, Promise<void>>();
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
  private connected = false;
  private inFlight = new Set<string>();
  private saving = new Set<string>();
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
        const values = this.storage.records
          ? (await this.storage.records.load()).map((raw) => Intent.parse(JSON.parse(raw)))
          : z.array(Intent).parse(JSON.parse((await this.storage.load()) ?? "[]"));
        // Old builds retained settled payloads indefinitely. Trim them before enforcing bounds.
        for (const intent of values) {
          if (intent.command.deviceId !== this.device || this.records.has(intent.command.id))
            throw new Error("Outbox identity mismatch");
          this.records.set(intent.command.id, intent);
        }
        const evicted = this.evict();
        if (values.length)
          await this.persist(undefined, [
            ...evicted,
            ...values.filter((entry) => !this.retained(entry)).map((entry) => entry.command.id),
          ]);
        for (const id of this.records.keys()) this.changed(id);
        this.ready = true;
      } catch {
        throw new ClientError("storage");
      }
    })();
    return this.initializing;
  }
  get(id: string): Intent | undefined {
    return this.optimistic.get(id) ?? this.records.get(id);
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
    const command = Command.parse({ id, deviceId: this.device, payload });
    const existing = this.get(id);
    if (existing && JSON.stringify(existing.command) !== JSON.stringify(command))
      return Promise.reject(
        new ClientError("protocol", "Idempotency key reused with different payload"),
      );
    const inflight = this.enqueuing.get(id);
    if (inflight) return inflight;
    if (!existing || existing.localFailure) {
      if (existing?.localFailure) this.records.delete(id);
      this.optimistic.set(id, { command, state: "saving" });
      this.changed(id);
    }
    const operation = this.serialize(async () => {
      if (!this.ready) throw new ClientError("storage");
      const command = Command.parse({ id, deviceId: this.device, payload });
      if (!fitsUtf8(JSON.stringify({ type: "command", command }), this.frameBytes))
        throw new ClientError("limit");
      const existing = this.records.get(id);
      if (existing) {
        if (JSON.stringify(existing.command) !== JSON.stringify(command))
          throw new ClientError("protocol", "Idempotency key reused with different payload");
        if (existing.state === "pending") this.pump();
        else if (this.connected) this.send(existing.command);
        return;
      }
      const intent: Intent = { command, state: "pending" };
      this.saving.add(id);
      this.records.set(id, intent);
      let evicted: string[];
      try {
        evicted = this.evict(id);
        await this.persist(intent, evicted);
      } catch (error) {
        this.records.delete(id);
        this.saving.delete(id);
        throw error instanceof ClientError ? error : new ClientError("storage");
      }
      this.saving.delete(id);
      this.optimistic.delete(id);
      this.changed(id);
      this.pump();
    })
      .catch((error: unknown) => {
        if (this.optimistic.has(id)) {
          this.optimistic.set(id, {
            command,
            state: "failed",
            error: error instanceof ClientError ? error.code : "storage",
          });
          this.changed(id);
        }
        throw error;
      })
      .finally(() => this.enqueuing.delete(id));
    this.enqueuing.set(id, operation);
    return operation;
  }
  /** A daemon refusal of one command. Transient ones stay pending and resend with backoff. */
  refuse(commandId: string, code: string, retryable: boolean): Promise<void> {
    const intent = this.records.get(commandId);
    if (intent?.state !== "pending") return Promise.resolve();
    const retry = this.retries.get(commandId) ?? { attempt: 0, cancel: undefined };
    if (!retryable || retry.attempt >= maxRetries)
      return this.acknowledge({ commandId: intent.command.id, ok: false, error: code });
    this.inFlight.delete(commandId);
    retry.cancel?.();
    retry.cancel = this.retryAfter(retry.attempt++, () => {
      retry.cancel = undefined;
      if (this.records.get(commandId)?.state === "pending") this.pump();
    });
    this.retries.set(commandId, retry);
    this.pump();
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
      if (previous.delivered) next.delivered = true;
      if (result.threadId) next.threadId = result.threadId;
      this.records.set(result.commandId, next);
      try {
        const evicted = this.evict(result.commandId);
        await this.persist(next, evicted);
      } catch {
        this.records.set(result.commandId, previous);
        throw new ClientError("storage");
      }
      this.changed(result.commandId);
    }).finally(() => {
      this.acknowledging.delete(result.commandId);
      this.inFlight.delete(result.commandId);
      this.pump();
    });
  }
  values(): readonly Intent[] {
    return [...new Map([...this.records, ...this.optimistic]).values()];
  }
  waiting(id: string): void {
    const previous = this.records.get(id);
    if (previous?.state !== "pending" || previous.waiting) return;
    this.records.set(id, { ...previous, waiting: true });
    this.changed(id);
  }
  /** The admission item replaced the optimistic bubble. Release its persisted payload. */
  observe(id: string): Promise<void> {
    return this.serialize(async () => {
      const previous = this.records.get(id);
      if (!previous || previous.delivered) return;
      const next = { ...previous, delivered: true };
      this.records.set(id, next);
      try {
        await this.persist(next, []);
      } catch {
        this.records.set(id, previous);
        throw new ClientError("storage");
      }
      this.changed(id);
    });
  }
  private retained(intent: Intent): boolean {
    return (
      intent.state !== "acked" ||
      ((intent.command.payload.type === "thread.send" ||
        intent.command.payload.type === "thread.create") &&
        !intent.delivered)
    );
  }
  /** Bound memory as well as disk, evicting settled entries before refusing active work. */
  private evict(protect?: string): string[] {
    const evicted: string[] = [];
    const fits = () =>
      this.records.size <= this.limit &&
      fitsUtf8(JSON.stringify([...this.records.values()]), this.bytes);
    for (const [id, intent] of this.records) {
      if (fits()) break;
      if (
        id === protect ||
        intent.state === "pending" ||
        (intent.state === "acked" && this.retained(intent))
      )
        continue;
      this.records.delete(id);
      evicted.push(id);
      this.changed(id);
    }
    if (!fits()) throw new ClientError("limit");
    return evicted;
  }
  private async persist(intent: Intent | undefined, evicted: readonly string[]): Promise<void> {
    const records = this.storage.records;
    if (records) {
      for (const id of evicted) await records.write(id, null);
      if (intent)
        await records.write(
          intent.command.id,
          this.retained(intent) ? JSON.stringify(intent) : null,
        );
      return;
    }
    await this.storage.save(
      JSON.stringify([...this.records.values()].filter((entry) => this.retained(entry))),
    );
  }
  settled(): Promise<void> {
    return this.chain;
  }
  disconnect(): void {
    this.connected = false;
    this.inFlight.clear();
    for (const retry of this.retries.values()) {
      retry.cancel?.();
      retry.cancel = undefined;
    }
  }
  private pump(): void {
    if (!this.connected) return;
    for (const intent of this.records.values()) {
      if (!this.connected || this.inFlight.size >= 8) break;
      const id = intent.command.id;
      if (
        intent.state !== "pending" ||
        this.saving.has(id) ||
        this.inFlight.has(id) ||
        this.acknowledging.has(id) ||
        this.retries.get(id)?.cancel
      )
        continue;
      this.inFlight.add(id);
      this.records.set(id, { ...intent, sent: true });
      this.changed(id);
      this.send(intent.command);
    }
  }
  replay(): void {
    this.connected = true;
    this.inFlight.clear();
    // Replay resends every pending intent; a scheduled retry would only duplicate it.
    for (const retry of this.retries.values()) {
      retry.cancel?.();
      retry.cancel = undefined;
    }
    this.pump();
  }
}
