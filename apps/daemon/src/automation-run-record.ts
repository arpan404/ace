import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { Store } from "./store.ts";

/**
 * One durable record per automation run, shared by every automation executor: the thread the
 * run went to, the command that carries its message now (a resend replaces it), the engine run
 * that took the message, what became of the message as last seen, and the run's cancellation.
 * `version` counts changes; each stop attempt is named by it, so a retry is a new command.
 */
const Row = z.object({
  command_id: CommandId,
  device_id: DeviceId,
  automation_id: z.string(),
  thread_id: ThreadId.nullable(),
  input_command: CommandId.nullable(),
  version: z.number().int().nonnegative(),
  engine_run: z.string().nullable(),
  disposition: z.string(),
  cancel: z.enum(["requested", "sent", "acknowledged"]).nullable(),
  stop_target: z.string().nullable(),
  stop_commands: z.string().nullable(),
  stop_attempts: z.number().int().nonnegative(),
  stop_retry_at: z.number().nullable(),
  stop_error: z.string().nullable(),
});

export interface RunRecord {
  commandId: CommandId;
  deviceId: DeviceId;
  automationId: string;
  threadId: ThreadId | undefined;
  inputCommand: CommandId | undefined;
  version: number;
  engineRun: string | undefined;
  disposition: string;
  cancel: "requested" | "sent" | "acknowledged" | undefined;
  /** What the last stop was aimed at, so the same stop is never sent twice. */
  stopTarget: string | undefined;
  /** The commands that stop sent, whose delivery the monitor checks. */
  stopCommands: CommandId[];
  /** Stops whose delivery failed so far, the next try's time, and why it gave up, if it did. */
  stopAttempts: number;
  stopRetryAt: number | undefined;
  stopError: string | undefined;
}

export class RunRecords {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS automation_executions(
        command_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, automation_id TEXT NOT NULL,
        thread_id TEXT, input_command TEXT, version INTEGER NOT NULL DEFAULT 0, engine_run TEXT,
        disposition TEXT NOT NULL DEFAULT 'pending', cancel TEXT, stop_target TEXT
      );
      DROP TABLE IF EXISTS automation_run_threads;
      DROP TABLE IF EXISTS agent_automation_run_threads;`),
    );
    store.atomic((db) => {
      const columns = new Set(
        db
          .prepare("PRAGMA table_info(automation_executions)")
          .all()
          .map((row) => String(row.name)),
      );
      for (const [name, definition] of [
        ["stop_commands", "TEXT"],
        ["stop_attempts", "INTEGER NOT NULL DEFAULT 0"],
        ["stop_retry_at", "INTEGER"],
        ["stop_error", "TEXT"],
      ] as const)
        if (!columns.has(name))
          db.exec(`ALTER TABLE automation_executions ADD COLUMN ${name} ${definition}`);
    });
  }
  get(commandId: CommandId): RunRecord | undefined {
    const row = this.store
      .statement("SELECT * FROM automation_executions WHERE command_id=?")
      .get(commandId);
    if (!row) return undefined;
    const value = Row.parse(row);
    return {
      commandId: value.command_id,
      deviceId: value.device_id,
      automationId: value.automation_id,
      threadId: value.thread_id ?? undefined,
      inputCommand: value.input_command ?? undefined,
      version: value.version,
      engineRun: value.engine_run ?? undefined,
      disposition: value.disposition,
      cancel: value.cancel ?? undefined,
      stopTarget: value.stop_target ?? undefined,
      stopCommands: value.stop_commands
        ? z.array(CommandId).parse(JSON.parse(value.stop_commands))
        : [],
      stopAttempts: value.stop_attempts,
      stopRetryAt: value.stop_retry_at ?? undefined,
      stopError: value.stop_error ?? undefined,
    };
  }
  /** The run's message went to `threadId` as command `commandId`. */
  admit(commandId: CommandId, deviceId: DeviceId, automationId: string, threadId: ThreadId): void {
    this.store
      .statement(
        `INSERT INTO automation_executions(command_id,device_id,automation_id,thread_id,input_command,disposition)
        VALUES (?,?,?,?,?,'sent') ON CONFLICT(command_id) DO UPDATE SET thread_id=excluded.thread_id,
        input_command=COALESCE(input_command,excluded.input_command),version=version+1`,
      )
      .run(commandId, deviceId, automationId, threadId, commandId);
  }
  /**
   * Ask for the run to be stopped. A run with no record yet gets one carrying only the request,
   * so an admission still on its way finds it and sends nothing.
   */
  requestCancel(commandId: CommandId, deviceId: DeviceId, automationId: string): void {
    this.store
      .statement(
        `INSERT INTO automation_executions(command_id,device_id,automation_id,cancel) VALUES (?,?,?,'requested')
        ON CONFLICT(command_id) DO UPDATE SET cancel=COALESCE(cancel,'requested'),version=version+1`,
      )
      .run(commandId, deviceId, automationId);
  }
  /** The message's latest fate, and the engine run that took it once one has. */
  observe(commandId: CommandId, disposition: string, engineRun: string | undefined): void {
    this.store
      .statement(
        `UPDATE automation_executions SET disposition=?,engine_run=COALESCE(?,engine_run),version=version+1
        WHERE command_id=? AND (disposition<>? OR (? IS NOT NULL AND engine_run IS NOT ?))`,
      )
      .run(
        disposition,
        engineRun ?? null,
        commandId,
        disposition,
        engineRun ?? null,
        engineRun ?? null,
      );
  }
  /** The person sent the message again: the run follows the new command. */
  replace(commandId: CommandId, replacement: CommandId): void {
    this.store
      .statement(
        "UPDATE automation_executions SET input_command=?,engine_run=NULL,disposition='replaced',version=version+1 WHERE command_id=?",
      )
      .run(replacement, commandId);
  }
  /**
   * A stop aimed at `target` was admitted as `commands` (or nothing was left to stop, with no
   * target). Admitted is not delivered: the monitor checks each command's delivery.
   */
  stopSent(
    commandId: CommandId,
    target: string | undefined,
    commands: readonly CommandId[] = [],
  ): void {
    this.store
      .statement(
        "UPDATE automation_executions SET cancel='sent',stop_target=?,stop_commands=?,version=version+1 WHERE command_id=?",
      )
      .run(target ?? null, JSON.stringify(commands), commandId);
  }
  /**
   * The stop's delivery failed: it is sent again as a new command from `retryAt`, or, with no
   * `retryAt`, given up on with `error`, which the run's result then says.
   */
  stopFailed(commandId: CommandId, error: string, retryAt: number | undefined): void {
    this.store
      .statement(
        `UPDATE automation_executions SET stop_target=NULL,stop_commands=NULL,stop_attempts=stop_attempts+1,
        stop_retry_at=?,stop_error=?,version=version+1 WHERE command_id=?`,
      )
      .run(retryAt ?? null, retryAt === undefined ? error : null, commandId);
  }
  /** A stop was refused (the queue or turn moved on): the next attempt is a new command. */
  stopRefused(commandId: CommandId): void {
    this.store
      .statement("UPDATE automation_executions SET version=version+1 WHERE command_id=?")
      .run(commandId);
  }
  /** The run is over; a cancellation it had is carried out. */
  settle(commandId: CommandId): void {
    this.store
      .statement(
        "UPDATE automation_executions SET disposition='settled',cancel=CASE WHEN cancel IS NULL THEN NULL ELSE 'acknowledged' END,version=version+1 WHERE command_id=?",
      )
      .run(commandId);
  }
}
