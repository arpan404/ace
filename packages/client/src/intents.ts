import { fitsUtf8 } from "./bounds.ts";
import { z } from "zod";
import { Command, CommandResult, type CommandPayload, type DeviceId } from "@ace/protocol";
import { ClientError, type Storage } from "./types.ts";

const Intent = z.object({
  command: Command,
  state: z.enum(["saving", "pending", "acked", "failed"]),
  error: z.string().optional(),
  delivered: z.boolean().optional(),
  acknowledged: z.boolean().optional(),
  threadId: z.string().optional(),
  waiting: z.boolean().optional(),
  localFailure: z.boolean().optional(),
  order: z.number().int().nonnegative().optional(),
});
export type Intent = z.infer<typeof Intent>;
/** A transient refusal (update drain, rolled-back transaction) is retried this many times. */
const maxRetries = 10;
interface IntentsOptions {
  storage: Storage;
  device: DeviceId;
  limit: number;
  bytes: number;
  frameBytes: number;
  changed(id: string): void;
  send(command: Command): void;
  retryAfter(attempt: number, run: () => void): () => void;
}
export class Intents {
  #records = new Map<string, Intent>();
  #sizes = new Map<string, number>();
  #retainedBytes = 0;
  #enqueuing = new Map<string, Promise<void>>();
  #operations = 0;
  #sequence = 0;
  #acknowledging = new Set<string>();
  #chain: Promise<void> = Promise.resolve();
  #retries = new Map<string, { attempt: number; cancel: (() => void) | undefined }>();
  #ready = false;
  #connected = false;
  #inFlight = new Set<string>();
  #saving = new Set<string>();
  #initializing: Promise<void> | undefined;
  #options: IntentsOptions;
  constructor(options: IntentsOptions) {
    this.#options = options;
  }
  initialize(): Promise<void> {
    this.#initializing ??= (async () => {
      try {
        const values = this.#options.storage.records
          ? (await this.#options.storage.records.load()).map((raw) => Intent.parse(JSON.parse(raw)))
          : z.array(Intent).parse(JSON.parse((await this.#options.storage.load()) ?? "[]"));
        // Old builds retained settled payloads indefinitely. Trim them before enforcing bounds.
        for (const intent of values.toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
          this.#sequence = Math.max(this.#sequence, intent.order ?? 0);
          if (
            intent.command.deviceId !== this.#options.device ||
            this.#records.has(intent.command.id)
          )
            throw new Error("Outbox identity mismatch");
          this.#put(intent.command.id, intent);
        }
        const evicted = this.#evict();
        if (values.length)
          await this.#persist(undefined, [
            ...evicted,
            ...values.filter((entry) => !this.#retained(entry)).map((entry) => entry.command.id),
          ]);
        for (const id of this.#records.keys()) this.#options.changed(id);
        this.#ready = true;
      } catch {
        throw new ClientError("storage");
      }
    })();
    return this.#initializing;
  }
  get(id: string): Intent | undefined {
    return this.#records.get(id);
  }
  #serialize(run: () => Promise<void>): Promise<void> {
    if (this.#operations >= this.#options.limit * 2)
      return Promise.reject(new ClientError("limit"));
    this.#operations++;
    const result = this.#chain.then(run).finally(() => {
      this.#operations--;
    });
    this.#chain = result.catch(() => {});
    return result;
  }
  enqueue(id: string, payload: CommandPayload): Promise<void> {
    const command = Command.parse({ id, deviceId: this.#options.device, payload });
    if (
      !fitsUtf8(JSON.stringify({ type: "command", command }), this.#options.frameBytes) ||
      !fitsUtf8(JSON.stringify({ command, state: "saving" }), this.#options.bytes - 128)
    )
      return Promise.reject(new ClientError("limit"));
    const existing = this.get(id);
    if (existing && JSON.stringify(existing.command) !== JSON.stringify(command))
      return Promise.reject(
        new ClientError("protocol", "Idempotency key reused with different payload"),
      );
    const inflight = this.#enqueuing.get(id);
    if (inflight) return inflight.then(() => this.enqueue(id, payload));
    const evictedBefore: string[] = [];
    if (!existing || existing.localFailure) {
      if (existing?.localFailure) this.#remove(id);
      this.#put(id, { command, state: "saving" });
      try {
        evictedBefore.push(...this.#evict(id));
      } catch (error) {
        this.#remove(id);
        return Promise.reject(error);
      }
      this.#options.changed(id);
    }
    const operation = this.#serialize(async () => {
      if (!this.#ready) throw new ClientError("storage");
      const stored = this.#records.get(id);
      if (stored && stored.state !== "saving") {
        if (stored.state === "pending") this.#pump();
        else if (this.#connected) this.#options.send(stored.command);
        return;
      }
      const intent: Intent = { command, state: "pending", order: ++this.#sequence };
      this.#saving.add(id);
      let evicted: string[];
      try {
        evicted = [...evictedBefore, ...this.#evict(id)];
        await this.#persist(intent, evicted);
      } catch (error) {
        this.#saving.delete(id);
        throw error instanceof ClientError ? error : new ClientError("storage");
      }
      this.#saving.delete(id);
      this.#put(id, intent);
      this.#options.changed(id);
      this.#pump();
    })
      .catch((error: unknown) => {
        if (this.#records.get(id)?.state === "saving") {
          this.#put(id, {
            command,
            state: "failed",
            localFailure: true,
            error: error instanceof ClientError ? error.code : "storage",
          });
          this.#trimFailed(id);
          try {
            this.#evict(id);
          } catch {
            this.#remove(id);
          }
          this.#options.changed(id);
        }
        throw error;
      })
      .finally(() => this.#enqueuing.delete(id));
    this.#enqueuing.set(id, operation);
    return operation;
  }
  /** A daemon refusal of one command. Transient ones stay pending and resend with backoff. */
  refuse(commandId: string, code: string, retryable: boolean): Promise<void> {
    const intent = this.#records.get(commandId);
    if (intent?.state !== "pending") return Promise.resolve();
    const retry = this.#retries.get(commandId) ?? { attempt: 0, cancel: undefined };
    if (!retryable || retry.attempt >= maxRetries)
      return this.acknowledge({ commandId: intent.command.id, ok: false, error: code });
    this.#inFlight.delete(commandId);
    retry.cancel?.();
    retry.cancel = this.#options.retryAfter(retry.attempt++, () => {
      retry.cancel = undefined;
      if (this.#records.get(commandId)?.state === "pending") this.#pump();
    });
    this.#retries.set(commandId, retry);
    this.#pump();
    return Promise.resolve();
  }
  acknowledge(result: CommandResult): Promise<void> {
    this.#retries.get(result.commandId)?.cancel?.();
    this.#retries.delete(result.commandId);
    if (
      this.#acknowledging.has(result.commandId) ||
      this.#records.get(result.commandId)?.state !== "pending"
    )
      return Promise.resolve();
    this.#acknowledging.add(result.commandId);
    return this.#serialize(async () => {
      const previous = this.#records.get(result.commandId);
      if (!previous || previous.state !== "pending") return;
      const next: Intent = {
        ...previous,
        state: result.ok ? "acked" : "failed",
        error: result.error,
        threadId: result.threadId,
      };
      this.#put(result.commandId, next);
      try {
        const evicted = this.#evict(result.commandId);
        await this.#persist(next, evicted);
      } catch {
        this.#put(result.commandId, previous);
        throw new ClientError("storage");
      }
      this.#options.changed(result.commandId);
    }).finally(() => {
      this.#acknowledging.delete(result.commandId);
      this.#inFlight.delete(result.commandId);
      this.#pump();
    });
  }
  /**
   * A create the daemon settled as failed (a worktree that couldn't be made, or was cancelled)
   * goes again under the same id when the person picks Retry or the local checkout: the daemon
   * reruns it from its retained draft and answers with another receipt, so the intent waits for
   * that receipt without being resent. `undo` puts the failure back if the daemon refused.
   */
  reopen(id: string): { undo(): void } {
    const previous = this.#records.get(id);
    if (previous?.state !== "failed" || previous.localFailure) return { undo() {} };
    const { error: _error, waiting: _waiting, ...rest } = previous;
    const next: Intent = { ...rest, state: "pending" };
    this.#put(id, next);
    this.#inFlight.add(id);
    this.#options.changed(id);
    const save = (intent: Intent) =>
      void this.#serialize(() => this.#persist(intent, [])).catch(() => {});
    save(next);
    return {
      undo: () => {
        if (this.#records.get(id) !== next) return;
        this.#put(id, previous);
        this.#inFlight.delete(id);
        this.#options.changed(id);
        save(previous);
      },
    };
  }
  deliveryFailed(id: string, error: string): Promise<void> {
    const current = this.#records.get(id);
    if (!current || current.acknowledged || (current.state === "failed" && current.error === error))
      return Promise.resolve();
    return this.#serialize(async () => {
      const previous = this.#records.get(id);
      if (!previous || previous.acknowledged) return;
      const next: Intent = { ...previous, state: "failed", localFailure: true, error };
      this.#put(id, next);
      try {
        let evicted: string[];
        try {
          evicted = [...this.#trimFailed(id), ...this.#evict(id)];
        } catch {
          this.#remove(id);
          evicted = [id];
        }
        await this.#persist(next, evicted);
      } catch {
        this.#put(id, previous);
        throw new ClientError("storage");
      }
      this.#inFlight.delete(id);
      this.#retries.get(id)?.cancel?.();
      this.#retries.delete(id);
      this.#options.changed(id);
      this.#pump();
    });
  }
  waiting(id: string): void {
    const previous = this.#records.get(id);
    if (previous?.state !== "pending" || previous.waiting) return;
    this.#put(id, { ...previous, waiting: true });
    this.#options.changed(id);
  }
  /** The admission item replaced the optimistic bubble. Release its persisted payload. */
  observe(id: string, acknowledged = false): Promise<void> {
    const current = this.#records.get(id);
    if (!current || (current.delivered && (!acknowledged || current.acknowledged)))
      return Promise.resolve();
    return this.#serialize(async () => {
      const previous = this.#records.get(id);
      if (!previous || (previous.delivered && (!acknowledged || previous.acknowledged))) return;
      const { error: _error, localFailure: _local, ...rest } = previous;
      const next: Intent = acknowledged
        ? { ...rest, state: "acked", delivered: true, acknowledged: true }
        : { ...previous, delivered: true };
      this.#put(id, next);
      try {
        await this.#persist(next, []);
      } catch {
        this.#put(id, previous);
        throw new ClientError("storage");
      }
      this.#options.changed(id);
    });
  }
  #put(id: string, intent: Intent): void {
    const size = new TextEncoder().encode(JSON.stringify(intent)).byteLength;
    this.#retainedBytes += size - (this.#sizes.get(id) ?? 0);
    this.#sizes.set(id, size);
    this.#records.set(id, intent);
  }
  #remove(id: string): void {
    this.#retainedBytes -= this.#sizes.get(id) ?? 0;
    this.#sizes.delete(id);
    this.#records.delete(id);
  }
  #trimFailed(protect: string): string[] {
    let failed = 0;
    const removed: string[] = [];
    for (const entry of this.#records.values()) if (entry.localFailure) failed++;
    for (const [id, entry] of this.#records) {
      if (failed <= Math.min(64, this.#options.limit)) break;
      if (!entry.localFailure || id === protect) continue;
      this.#remove(id);
      this.#options.changed(id);
      removed.push(id);
      failed--;
    }
    return removed;
  }
  #retained(intent: Intent): boolean {
    // A successful receipt transfers durability to the daemon's admission transaction.
    // Transcript leases and preview windows only determine the visible delivered state.
    return intent.state !== "acked" && intent.state !== "saving" && !intent.localFailure;
  }
  /** Bound memory as well as disk, evicting settled entries before refusing active work. */
  #evict(protect?: string): string[] {
    const evicted: string[] = [];
    const fits = () =>
      this.#records.size <= this.#options.limit &&
      this.#retainedBytes + 2 + Math.max(0, this.#records.size - 1) <= this.#options.bytes;
    for (const [id, intent] of this.#records) {
      if (fits()) break;
      if (id === protect || intent.state === "pending" || intent.state === "saving") continue;
      this.#remove(id);
      evicted.push(id);
      this.#options.changed(id);
    }
    if (!fits()) throw new ClientError("limit");
    return evicted;
  }
  async #persist(intent: Intent | undefined, evicted: readonly string[]): Promise<void> {
    const records = this.#options.storage.records;
    if (records) {
      for (const id of evicted) await records.write(id, null);
      if (intent)
        await records.write(
          intent.command.id,
          this.#retained(intent) ? JSON.stringify(intent) : null,
        );
      return;
    }
    await this.#options.storage.save(
      JSON.stringify(
        [...this.#records.values()]
          .map((entry) => (intent?.command.id === entry.command.id ? intent : entry))
          .filter((entry) => this.#retained(entry)),
      ),
    );
  }
  settled(): Promise<void> {
    return this.#chain;
  }
  disconnect(): void {
    this.#connected = false;
    this.#inFlight.clear();
    for (const retry of this.#retries.values()) {
      retry.cancel?.();
      retry.cancel = undefined;
    }
  }
  #pump(): void {
    if (!this.#connected) return;
    for (const intent of this.#records.values()) {
      if (!this.#connected || this.#inFlight.size >= 8) break;
      const id = intent.command.id;
      if (
        intent.state !== "pending" ||
        this.#saving.has(id) ||
        this.#inFlight.has(id) ||
        this.#acknowledging.has(id) ||
        this.#retries.get(id)?.cancel
      )
        continue;
      this.#inFlight.add(id);
      this.#options.send(intent.command);
    }
  }
  replay(): void {
    this.#connected = true;
    this.#inFlight.clear();
    // Replay resends every pending intent; a scheduled retry would only duplicate it.
    for (const retry of this.#retries.values()) {
      retry.cancel?.();
      retry.cancel = undefined;
    }
    this.#pump();
  }
}
