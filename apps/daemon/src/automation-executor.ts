import { createHash } from "node:crypto";
import { Command, CommandId, ThreadId, WorkspaceId, DeviceId } from "@ace/protocol";
import type { AutomationExecutor, ExecutionResult } from "@ace/automations";
import type { ServiceContext } from "./services/types.ts";
import { commandContext } from "./commands.ts";

/** Idempotent native admission; monitors consume whole-tree status, never root completion. */
export function automationExecutor(context: ServiceContext): AutomationExecutor {
  const { store, services } = context;
  const lookup = (commandId: string) =>
    store.atomic((db) => {
      const row = db
        .prepare("SELECT result FROM command_receipts WHERE command_id=?")
        .get(commandId);
      if (!row) return undefined;
      return importResult(row.result);
    });
  const monitor = (id: ThreadId, signal: AbortSignal): Promise<ExecutionResult> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      let stop = noop;
      const abort = () => {
        stop();
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      const inspect = () => {
        const thread = store.getThread(id);
        if (
          !thread ||
          thread.deletedAt !== undefined ||
          thread.status.state === "failed" ||
          thread.status.state === "done"
        ) {
          stop();
          signal.removeEventListener("abort", abort);
          resolve({
            threadId: id,
            status: thread?.status.state === "done" ? "succeeded" : "failed",
            result:
              thread?.status.state === "done" ? "Thread completed" : "Thread failed or unavailable",
          });
        }
      };
      stop = store.subscribe((events) => {
        if (
          events.some(
            (event) =>
              event.threadId === id &&
              (event.payload.type === "thread.updated" ||
                event.payload.type === "thread.client.updated"),
          )
        )
          inspect();
      });
      signal.addEventListener("abort", abort, { once: true });
      inspect();
    });
  return {
    execute(input, signal) {
      const handler = services.engine?.internalHandler ?? services.handler;
      if (!handler) throw new Error("engine_unavailable");
      const workspaceId = store.atomic((db) =>
        WorkspaceId.parse(
          db
            .prepare("SELECT id FROM workspaces WHERE path=? OR id=? LIMIT 1")
            .get(input.workspace, input.workspace)?.id,
        ),
      );
      const command = Command.parse({
        id: executionKey(input.idempotencyKey),
        deviceId: DeviceId.parse("automation"),
        payload: {
          type: "thread.create",
          workspaceId,
          provider: input.provider,
          trigger: "schedule",
          origin: { kind: "automation", role: input.automationId },
          ...(input.model ? { model: input.model } : {}),
          mode: input.worktree ? "worktree" : "local",
          title: `Automation: ${input.automationId}`.slice(0, 256),
          input: [{ type: "text", text: input.prompt }],
        },
      });
      const result = store.recordCommand(command.id, command.deviceId, () =>
        handler.handle(command, commandContext(store)),
      );
      if (!result.ok || !result.threadId)
        throw new Error(result.error ?? "automation_admission_failed");
      return monitor(result.threadId, signal);
    },
    async recover(idempotencyKey, signal) {
      const result = lookup(executionKey(idempotencyKey));
      if (!result) return undefined;
      if (!result.ok || !result.threadId)
        throw new Error(result.error ?? "automation_admission_failed");
      return monitor(result.threadId, signal);
    },
  };
}
import { CommandResult } from "@ace/protocol";
function importResult(value: unknown) {
  if (typeof value !== "string") throw new Error("Invalid receipt");
  return CommandResult.parse(JSON.parse(value));
}

const executionKey = (value: string) =>
  CommandId.parse(`automation-${createHash("sha256").update(value).digest("hex")}`);

function noop(): void {}
