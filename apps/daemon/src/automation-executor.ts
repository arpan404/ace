import { createHash } from "node:crypto";
import { Command, CommandId, ThreadId, WorkspaceId, DeviceId } from "@ace/protocol";
import type { AutomationExecutor, ExecutionResult } from "@ace/automations";
import type { ServiceContext } from "./services/types.ts";
import { commandContext } from "./commands.ts";
import { readThreadTree } from "./thread-tree.ts";
import { treeOutcome } from "./work-outcome.ts";
import { systemClock } from "./engine/actor.ts";

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
      let cancelTimer = noop;
      let settled = false;
      let members = new Set<ThreadId>([id]);
      const abort = () => {
        settled = true;
        cancelTimer();
        stop();
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      const inspect = () => {
        if (settled) return;
        const thread = store.getThread(id);
        const facts = readThreadTree(context, id);
        if (facts) members = new Set(facts.map((member) => member.threadId));
        const outcome = facts && treeOutcome(facts);
        if (!thread || thread.deletedAt !== undefined || outcome === "failed" || outcome === "ok") {
          settled = true;
          cancelTimer();
          stop();
          signal.removeEventListener("abort", abort);
          resolve({
            threadId: id,
            status: outcome === "ok" ? "succeeded" : "failed",
            result:
              outcome === "ok"
                ? "Thread tree completed"
                : "Thread failed, cancelled or unavailable",
          });
        }
      };
      stop = store.subscribe((events) => {
        if (
          events.some(
            (event) =>
              members.has(event.threadId) &&
              (event.payload.type === "thread.updated" ||
                event.payload.type === "thread.client.updated" ||
                event.payload.type === "queue.updated"),
          )
        )
          inspect();
      });
      signal.addEventListener("abort", abort, { once: true });
      const clock = context.options.engine?.clock ?? systemClock;
      const refresh = () => {
        inspect();
        if (!settled) cancelTimer = clock.setTimer(refresh, 500);
      };
      refresh();
    });
  return {
    async execute(input, signal) {
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
          ...(input.access ? { access: input.access } : {}),
          trigger: "schedule",
          origin: { kind: "automation", role: input.automationId },
          ...(input.model ? { model: input.model } : {}),
          mode: input.worktree ? "worktree" : "local",
          title: automationThreadTitle(input.title),
          input: [{ type: "text", text: input.prompt }],
        },
      });
      const result = await store.write(() =>
        store.recordCommand(command.id, command.deviceId, () =>
          handler.handle(command, commandContext(store)),
        ),
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

/** "Automation: Nightly triage": the automation's own name, never its id. */
export function automationThreadTitle(name: string | undefined): string {
  const title = name?.trim();
  return title ? `Automation: ${title}`.slice(0, 256) : "Automation run";
}
