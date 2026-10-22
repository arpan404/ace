import { createHash } from "node:crypto";
import type { AutomationExecutor } from "@ace/automations";
import { Command, CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { z } from "zod";
import { commandContext } from "../commands.ts";
import { followRun, stopRun } from "../automation-run-monitor.ts";
import type { ServiceContext } from "../services/types.ts";

const deviceId = DeviceId.parse("agent-automation");
const runKey = (value: string) =>
  CommandId.parse(`agent-automation-${createHash("sha256").update(value).digest("hex")}`);

/**
 * Runs an automation an agent made from its thread by sending the message into that same
 * thread, queued behind any turn already going, so every run is one more turn of it. The send is
 * idempotent by the run's key. A deleted or archived thread fails the run instead of waiting.
 */
export function ownerThreadExecutor(
  context: ServiceContext,
  ownerOf: (automationId: string) => ThreadId | undefined,
): AutomationExecutor {
  const { store, services } = context;
  store.atomic((db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS agent_automation_run_threads(
      command_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL
    );`),
  );
  const sentTo = (commandId: string): ThreadId | undefined => {
    const row = store.atomic((db) =>
      db
        .prepare("SELECT thread_id FROM agent_automation_run_threads WHERE command_id=?")
        .get(commandId),
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
  return {
    async execute(input, signal) {
      if (input.worktree) throw new Error("Use thread.handoff for worktrees");
      const threadId = ownerOf(input.automationId);
      const thread = threadId && store.getThread(threadId);
      if (!thread || thread.deletedAt !== undefined)
        throw new Error("The thread that made this automation was deleted.");
      if (thread.archivedAt !== undefined)
        throw new Error("The thread that made this automation is archived.");
      const handle = handler();
      const commandId = runKey(input.idempotencyKey);
      const command = Command.parse({
        id: commandId,
        deviceId,
        payload: {
          type: "thread.send",
          threadId: thread.id,
          delivery: "queue",
          trigger: "schedule",
          origin: { kind: "automation", role: input.automationId },
          // The agent's own thread keeps its own model and effort.
          input: [{ type: "text", text: input.prompt }],
        },
      });
      await store.write((db) => {
        const result = store.recordCommand(command.id, command.deviceId, () =>
          handle.handle(command, commandContext(store)),
        );
        if (!result.ok) throw new Error(result.error ?? "automation_admission_failed");
        db.prepare("INSERT OR IGNORE INTO agent_automation_run_threads VALUES (?,?)").run(
          commandId,
          thread.id,
        );
      });
      return followRun(context, thread.id, commandId, signal, {
        stop: { id: runKey(`${input.idempotencyKey}:stop`), deviceId },
      });
    },
    async recover(idempotencyKey, signal) {
      const commandId = runKey(idempotencyKey);
      const receipt = store.commandReceipt(commandId, deviceId);
      if (!receipt) return undefined;
      if (!receipt.ok) throw new Error(receipt.error ?? "automation_admission_failed");
      const threadId = sentTo(commandId);
      if (!threadId) throw new Error("automation_admission_failed");
      return followRun(context, threadId, commandId, signal, {
        recovered: true,
        stop: { id: runKey(`${idempotencyKey}:stop`), deviceId },
      });
    },
    async interrupt(input) {
      const commandId = runKey(input.idempotencyKey);
      const threadId = sentTo(commandId);
      if (!threadId) return;
      // Only this run's own turn or queued message stops; the thread's other work goes on.
      await stopRun(context, threadId, commandId, runKey(`${input.idempotencyKey}:stop`), deviceId);
    },
  };
}
