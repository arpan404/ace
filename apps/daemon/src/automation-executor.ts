import { createHash } from "node:crypto";
import { Command, CommandId, ThreadId, WorkspaceId, DeviceId } from "@ace/protocol";
import type { AutomationExecutor, ExecutionInput } from "@ace/automations";
import { z } from "zod";
import type { ServiceContext } from "./services/types.ts";
import { commandContext } from "./commands.ts";
import { followRun, stopRun } from "./automation-run-monitor.ts";

const deviceId = DeviceId.parse("automation");

/**
 * Runs a person's automation in its own one thread: the first run creates the thread, and every
 * later run sends its message into that same thread, queued behind any turn already going. Each
 * send is idempotent by the run's key, so a retry or a restart never sends twice, and the run's
 * result is the agent's own answer.
 */
export function automationExecutor(context: ServiceContext): AutomationExecutor {
  const { store, services } = context;
  store.atomic((db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS automation_threads(
      automation_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS automation_run_threads(
      command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL
    );`),
  );
  /** The automation's thread while it can still take a run: not deleted, not archived. */
  const ownThread = (automationId: string): ThreadId | undefined => {
    const row = store.atomic((db) =>
      db
        .prepare("SELECT thread_id FROM automation_threads WHERE automation_id=?")
        .get(automationId),
    );
    if (!row) return undefined;
    const id = ThreadId.parse(z.object({ thread_id: z.string() }).parse(row).thread_id);
    const thread = store.getThread(id);
    return thread && thread.deletedAt === undefined && thread.archivedAt === undefined
      ? thread.id
      : undefined;
  };
  /** The thread a run's command went to, kept beside its receipt. */
  const runThread = (commandId: string): ThreadId | undefined => {
    const row = store.atomic((db) =>
      db.prepare("SELECT thread_id FROM automation_run_threads WHERE command_id=?").get(commandId),
    );
    return row
      ? ThreadId.parse(z.object({ thread_id: z.string() }).parse(row).thread_id)
      : undefined;
  };
  const handler = () => {
    const handle = services.engine?.internalHandler ?? services.handler;
    if (!handle) throw new Error("engine_unavailable");
    return handle;
  };
  const workspaceOf = (workspace: string) =>
    store.atomic((db) =>
      WorkspaceId.parse(
        db
          .prepare("SELECT id FROM workspaces WHERE path=? OR id=? LIMIT 1")
          .get(workspace, workspace)?.id,
      ),
    );
  return {
    async execute(input, signal) {
      const handle = handler();
      const commandId = executionKey(input.idempotencyKey);
      const threadId = await store.write((db) => {
        // A retried run finds its first command's receipt and thread unchanged.
        const sent = runThread(commandId);
        const existing = sent ?? ownThread(input.automationId);
        const command = Command.parse({
          id: commandId,
          deviceId,
          payload: existing
            ? {
                type: "thread.send",
                threadId: existing,
                delivery: "queue",
                trigger: "schedule",
                origin: { kind: "automation", role: input.automationId },
                ...(input.model ? { model: input.model } : {}),
                ...(input.effort ? { options: { effort: input.effort } } : {}),
                input: [{ type: "text", text: input.prompt }],
              }
            : {
                type: "thread.create",
                workspaceId: workspaceOf(input.workspace),
                provider: input.provider,
                ...(input.access ? { access: input.access } : {}),
                trigger: "schedule",
                origin: { kind: "automation", role: input.automationId },
                ...(input.model ? { model: input.model } : {}),
                ...launchChoices(input),
                mode: input.worktree ? "worktree" : "local",
                title: automationThreadTitle(input.title),
                input: [{ type: "text", text: input.prompt }],
              },
        });
        const result = store.recordCommand(command.id, command.deviceId, () =>
          handle.handle(command, commandContext(store)),
        );
        if (!result.ok) throw new Error(result.error ?? "automation_admission_failed");
        const target = existing ?? result.threadId;
        if (!target) throw new Error("automation_admission_failed");
        db.prepare("INSERT OR IGNORE INTO automation_run_threads VALUES (?,?)").run(
          commandId,
          target,
        );
        if (!existing)
          db.prepare(
            "INSERT INTO automation_threads VALUES (?,?) ON CONFLICT(automation_id) DO UPDATE SET thread_id=excluded.thread_id",
          ).run(input.automationId, target);
        return target;
      });
      return followRun(context, threadId, commandId, signal, {
        stop: { id: executionKey(`${input.idempotencyKey}:stop`), deviceId },
      });
    },
    async recover(idempotencyKey, signal) {
      const commandId = executionKey(idempotencyKey);
      const receipt = store.commandReceipt(commandId, deviceId);
      if (!receipt) return undefined;
      if (!receipt.ok) throw new Error(receipt.error ?? "automation_admission_failed");
      const threadId = runThread(commandId) ?? receipt.threadId;
      if (!threadId) throw new Error("automation_admission_failed");
      return followRun(context, threadId, commandId, signal, {
        recovered: true,
        stop: { id: executionKey(`${idempotencyKey}:stop`), deviceId },
      });
    },
    async interrupt(input) {
      const commandId = executionKey(input.idempotencyKey);
      const threadId = runThread(commandId);
      if (!threadId) return;
      await stopRun(
        context,
        threadId,
        commandId,
        executionKey(`${input.idempotencyKey}:stop`),
        deviceId,
      );
    },
  };
}

const executionKey = (value: string) =>
  CommandId.parse(`automation-${createHash("sha256").update(value).digest("hex")}`);

/**
 * The effort and account a run starts on, carried as New thread carries them: the account as
 * `accountId` (ACP agents are picked by their own identity, which an automation doesn't store)
 * and the effort in the launch options.
 */
export function launchChoices(input: ExecutionInput): {
  accountId?: string;
  options?: { effort: string };
} {
  return {
    ...(input.instance && input.provider !== "acp" ? { accountId: input.instance } : {}),
    ...(input.effort ? { options: { effort: input.effort } } : {}),
  };
}

/** "Automation: Nightly triage": the automation's own name, never its id. */
export function automationThreadTitle(name: string | undefined): string {
  const title = name?.trim();
  return title ? `Automation: ${title}`.slice(0, 256) : "Automation run";
}
