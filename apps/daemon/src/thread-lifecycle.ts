import { Command, ThreadId, type CommandResult } from "@ace/protocol";
import { initializeThreadCleanup, threadCleaning } from "./thread-cleanup-journal.ts";
import { organizationDecision } from "@ace/projection";
import { organizerSchedule, type OrganizerSchedule } from "./thread-organizer.ts";
import type { ServerOptions } from "./server-options.ts";

/** How often the liveness backstop visits one batch of unsettled threads. */
const sweepMs = 30_000;

/** One host owner for liveness sweeps and crash-resumable deletion. */
export class ThreadLifecycle {
  private options: ServerOptions;
  private schedule: OrganizerSchedule;
  private cancel: (() => void) | undefined;
  private flights = new Map<ThreadId, Promise<void>>();
  private sweeping: Promise<void> | undefined;
  private after = "";
  private stopped = false;
  constructor(options: ServerOptions, schedule = organizerSchedule) {
    this.options = options;
    this.schedule = schedule;
    initializeThreadCleanup(options.store);
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  async start(): Promise<void> {
    await this.resume();
    this.next();
  }
  private members(id: ThreadId): ThreadId[] {
    return this.options.store
      .statement("SELECT thread_id FROM thread_cleanup_members WHERE owner=?")
      .all(id)
      .map((row) => ThreadId.parse(row.thread_id));
  }
  private alive(id: ThreadId): NonNullable<CommandResult["alive"]> {
    const owners = this.options.engine?.cleanupThreads(id) ?? [id];
    return {
      ...(this.options.engine?.liveWork(id) ?? { agentsRunning: 0, operationsRunning: 0 }),
      terminalsOpen: owners.reduce(
        (sum, owner) => sum + (this.options.workspaceActions?.liveTerminalCount(owner) ?? 0),
        0,
      ),
    };
  }
  private async reconcile(id: ThreadId): Promise<void> {
    for (const owner of this.options.engine?.cleanupThreads(id) ?? [id])
      await this.options.workspaceActions?.reconcileTerminals(owner);
    await this.options.engine?.reconcileThread(id);
  }
  async delete(command: Command): Promise<CommandResult> {
    const p = command.payload;
    if (p.type !== "thread.delete")
      return { commandId: command.id, ok: false, error: "invalid_command" };
    const store = this.options.store;
    const previous = store.commandReceipt(command.id, command.deviceId);
    if (previous && previous.error !== "client_action_pending") return previous;
    if (!previous && threadCleaning(store, p.threadId)) {
      // Another command already owns this deletion; finishing it satisfies this one too.
      await this.finish(p.threadId);
      return store.recordCommand(command.id, command.deviceId, () =>
        store.getThread(p.threadId)?.deletedAt === undefined
          ? { commandId: command.id, ok: false, error: "thread_deleting" }
          : { commandId: command.id, ok: true, threadId: p.threadId },
      );
    }
    if (!previous) await this.reconcile(p.threadId);
    let admitted = false;
    const receipt =
      previous ??
      store.recordCommand(command.id, command.deviceId, () => {
        const thread = store.getThread(p.threadId);
        if (!thread || thread.deletedAt !== undefined)
          return { commandId: command.id, ok: false, error: "thread_not_found" };
        if (threadCleaning(store, p.threadId))
          return { commandId: command.id, ok: false, error: "thread_deleting" };
        if (this.options.engine && store.workspaceReservations.threadReserved(p.threadId))
          return { commandId: command.id, ok: false, error: "workspace_change_in_progress" };
        const alive = this.alive(p.threadId);
        if (!p.force && Object.values(alive).some((count) => count > 0))
          return { commandId: command.id, ok: false, error: "thread_busy", alive };
        if (
          !p.force &&
          !this.options.engine &&
          typeof organizationDecision(thread, command, this.now()) === "string"
        )
          return {
            commandId: command.id,
            ok: false,
            error: "thread_busy",
            alive: { ...alive, agentsRunning: 1 },
          };
        if (this.flights.size >= 16)
          return { commandId: command.id, ok: false, error: "action_busy" };
        this.options.engine?.prepareDeletion(p.threadId, command.id);
        const owners = this.options.engine?.cleanupThreads(p.threadId) ?? [p.threadId];
        store
          .statement("INSERT INTO thread_cleanup VALUES (?,?)")
          .run(p.threadId, JSON.stringify(command));
        for (const owner of owners)
          store.statement("INSERT INTO thread_cleanup_members VALUES (?,?)").run(owner, p.threadId);
        admitted = true;
        return { commandId: command.id, ok: false, error: "client_action_pending" };
      });
    if (!admitted && receipt.error !== "client_action_pending") return receipt;
    await this.finish(p.threadId);
    return store.commandReceipt(command.id, command.deviceId) ?? receipt;
  }
  private finish(id: ThreadId): Promise<void> {
    const existing = this.flights.get(id);
    if (existing) return existing;
    const flight = (async () => {
      const value = this.options.store
        .statement("SELECT command FROM thread_cleanup WHERE thread_id=?")
        .get(id)?.command;
      if (typeof value !== "string") return;
      const command = Command.parse(JSON.parse(value));
      if (
        !this.options.engine &&
        this.options.store
          .statement("SELECT 1 FROM sqlite_master WHERE name='engine_sessions'")
          .get() &&
        this.members(id).some((owner) =>
          this.options.store
            .statement("SELECT 1 FROM engine_sessions WHERE thread_id=?")
            .get(owner),
        )
      )
        throw new Error("engine_unavailable");
      // Child sessions remain independently readable, but all their work is stopped.
      for (const owner of this.members(id).toReversed()) {
        await this.options.engine?.stopForDeletion(owner);
        await this.options.workspaceActions?.closeThreadTerminals(owner);
      }
      await this.options.store.writable();
      this.options.store.atomic((db) => {
        if (this.options.store.getThread(id)?.deletedAt === undefined)
          this.options.store.appendEvents(
            id,
            [
              {
                type: "thread.client.updated",
                changes: { deletedAt: this.now(), autoSettleAt: null },
              },
            ],
            this.now(),
          );
        this.options.store.completeAsyncCommand(command.id, {
          commandId: command.id,
          ok: true,
          threadId: id,
        });
        db.prepare("DELETE FROM thread_cleanup_members WHERE owner=?").run(id);
        db.prepare("DELETE FROM thread_cleanup WHERE thread_id=?").run(id);
      });
    })().finally(() => this.flights.delete(id));
    this.flights.set(id, flight);
    return flight;
  }
  /** Deletions a crash interrupted finish before new commands can observe them half-done. */
  private async resume(): Promise<void> {
    await this.options.store.writable();
    let after = "";
    while (!this.stopped) {
      const pending = this.options.store
        .statement(
          "SELECT thread_id FROM thread_cleanup WHERE thread_id>? ORDER BY thread_id LIMIT 16",
        )
        .all(after);
      if (!pending.length) return;
      for (const row of pending) {
        if (this.stopped) return;
        after = ThreadId.parse(row.thread_id);
        await this.finish(ThreadId.parse(row.thread_id)).catch((error: unknown) =>
          this.options.log?.(error),
        );
      }
    }
  }
  /**
   * Provider and terminal exits are observed as they happen, and startup recovery stops what
   * the previous daemon left running; this backstop settles anything a missed exit left
   * behind. Indexed batches cap reads even with years of retained threads. Exited terminals
   * stay open here so their output remains readable until delete or move.
   */
  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.cancel?.();
    this.sweeping = (async () => {
      await this.resume();
      const engine = this.options.engine;
      if (!engine) return;
      const rows = this.options.store
        .statement(
          `SELECT id FROM threads WHERE id>? AND json_extract(client,'$.deletedAt') IS NULL
          AND json_extract(status,'$.state') NOT IN ('new','done','failed') ORDER BY id LIMIT 64`,
        )
        .all(this.after);
      for (const row of rows) {
        if (this.stopped) return;
        const id = ThreadId.parse(row.id);
        this.after = id;
        await engine.reconcileOwn(id).catch((error: unknown) => this.options.log?.(error));
      }
      if (rows.length < 64) this.after = "";
    })().finally(() => {
      this.sweeping = undefined;
      this.next();
    });
    return this.sweeping;
  }
  private next(): void {
    if (this.stopped) return;
    this.cancel = this.schedule(sweepMs, () => {
      void this.sweep().catch((error: unknown) => this.options.log?.(error));
    });
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.cancel?.();
    await this.sweeping;
    await Promise.allSettled(this.flights.values());
  }
}
