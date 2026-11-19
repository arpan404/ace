import { createHash } from "node:crypto";
import { stopOwnedGroups } from "@ace/provider-kit/process";
import { CommandId, DeviceId, type CliOperation, type AgentControlResult } from "@ace/protocol";
import type { MaintenanceGate } from "@ace/service";
import type { Engine } from "../engine/index.ts";
import type { Store } from "../store.ts";
import type { Services } from "./types.ts";

/** What kill-all needs of the daemon: its gate, the device asking, the store and the engine. */
export interface KillAllContext {
  maintenance: MaintenanceGate;
  device(): string | undefined;
  options: {
    store: Pick<Store, "recordCommand" | "listThreads" | "completeAsyncCommand">;
    engine?:
      | Pick<
          Engine,
          | "cleanupThreads"
          | "hasUnfinishedWork"
          | "cleanupSession"
          | "stopForCancellation"
          | "flush"
        >
      | undefined;
    agentControl?:
      | {
          delegations: Pick<
            NonNullable<Services["agentControl"]>["delegations"],
            "cancelMember" | "command"
          >;
        }
      | undefined;
  };
}

export async function killAll(
  context: KillAllContext,
  operation: Extract<CliOperation, { op: "process.kill_all" }>,
): Promise<AgentControlResult> {
  const engine = context.options.engine;
  const owner = context.options.agentControl;
  if (!engine || !owner) return { ok: false, code: "unsupported" };
  // One kill-all at a time, and none while an update or stop holds admission. The person's
  // pause may stay: kill-all adds and removes only its own hold.
  if ((["kill", "update", "stop"] as const).some((hold) => context.maintenance.held(hold)))
    return { ok: false, code: "not_ready" };
  const receiptId = CommandId.parse(
    `cli-kill:${createHash("sha256").update(operation.key).digest("hex")}`,
  );
  const device = DeviceId.parse(context.device());
  let fresh = false;
  const prior = context.options.store.recordCommand(receiptId, device, () => {
    fresh = true;
    return { commandId: receiptId, ok: false, error: "client_action_pending" };
  });
  if (!fresh) return { ok: prior.ok, code: prior.ok ? undefined : "unavailable", data: prior };
  context.maintenance.enter("kill");
  try {
    const subtree = operation.threadId
      ? new Set(engine.cleanupThreads(operation.threadId))
      : undefined;
    const selected = context.options.store
      .listThreads()
      .filter(
        (thread) =>
          (!subtree || subtree.has(thread.id)) &&
          (!operation.provider || thread.provider === operation.provider) &&
          (!operation.project || thread.workspaceId === operation.project),
      );
    const stopped = new Set<import("@ace/protocol").ThreadId>();
    const cancelled = new Set<import("@ace/protocol").ThreadId>();
    for (const thread of selected) {
      if (!engine.hasUnfinishedWork(thread.id)) {
        await engine.cleanupSession(thread.id);
        stopped.add(thread.id);
        continue;
      }
      // Own admission and result delivery must be fenced before an interruption can settle children.
      owner.delegations.cancelMember(thread.id);
      const receipt = owner.delegations.command(
        `kill:${createHash("sha256").update(operation.key).update(thread.id).digest("hex")}`,
        {
          type: "thread.interrupt",
          threadId: thread.id,
          // The selected set already includes --thread descendants. Completed members
          // must never receive a cascade interruption from an unfinished ancestor.
          cascade: false,
        },
      );
      if (!receipt.ok) return { ok: false, code: "unavailable", data: receipt };
      stopped.add(thread.id);
      cancelled.add(thread.id);
      await engine.stopForCancellation(thread.id);
    }
    await engine.flush();
    if (!operation.threadId && !operation.provider && !operation.project) await stopOwnedGroups();
    context.options.store.completeAsyncCommand(receiptId, {
      commandId: receiptId,
      ok: true,
      detail: `Stopped ${stopped.size} threads`,
    });
    return {
      ok: true,
      data: {
        stopped: [...stopped],
        cancelled: [...cancelled],
        outcome: cancelled.size ? "cancelled" : "cleaned",
      },
    };
  } finally {
    context.maintenance.leave("kill");
  }
}
