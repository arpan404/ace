import { Command, type DeviceId, type CommandResult, type ServerMessage } from "@ace/protocol";
import { isMutationUnavailable } from "@ace/git";
import { commandContext } from "../commands.ts";
import { creationFailure, type CreationFailure } from "../creation-failure.ts";
import type { CreationProgress } from "../creation-progress.ts";
import type { CreationAdmission } from "../engine/creation-admissions.ts";
import type { CreationWorkspace } from "../creation-workspace.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/** How a start runs: in a new worktree, falling back to local, or continuing past failed setup. */
type Launch = "worktree" | "local" | "continue";
function localCommand(command: Command): Command {
  const p = command.payload;
  if (p.type !== "thread.create" && p.type !== "thread.prepare") return command;
  if (p.pullRequest) throw new Error("pr_requires_worktree");
  const { base: _base, baseBranch: _baseBranch, ...rest } = p;
  return Command.parse({ ...command, payload: { ...rest, mode: "local" } });
}
const pullRequestOf = (command: Command) => {
  const p = command.payload;
  return (p.type === "thread.create" || p.type === "thread.prepare") && Boolean(p.pullRequest);
};
export function createEngineSession(context: SocketContext): SocketService {
  const { options, send, canReadThread } = context;
  const drafts = options.workspaceActions?.creationDrafts;
  const deliver = (message: ServerMessage) => {
    if (context.connected()) send(message);
  };
  /** Operations this socket follows; a closed socket stops following, the work goes on. */
  const followed = new Set<string>();
  // Admitted creation outlives its socket: a dropped connection never discards a finished
  // worktree, and the device's replay of the same command attaches to it for the receipt.
  async function follow(operation: CreationProgress, commandId: string): Promise<void> {
    followed.add(commandId);
    try {
      deliver({ type: "commandResult", ...(await operation.settled) });
    } finally {
      followed.delete(commandId);
      drafts?.detach(commandId, deliver);
    }
  }
  async function accept(command: Command, device: DeviceId, how: Launch = "worktree") {
    const authority = context.authorityLease?.("operate") ?? (() => context.authorize("operate"));
    const payload = command.payload;
    const useLocal = how === "local";
    if (
      payload.type === "thread.create" &&
      payload.handoffFrom &&
      !canReadThread(payload.handoffFrom)
    ) {
      send({
        type: "commandResult",
        commandId: command.id,
        ok: false,
        error: "handoff_source_not_found",
      });
      return;
    }
    const receipt = options.store.commandReceipt(command.id, device);
    if (receipt) {
      send({ type: "commandResult", ...receipt });
      return;
    }
    const running = drafts?.attach(command.id, device, deliver);
    if (running) return follow(running, command.id);
    let admission: CreationAdmission | undefined;
    let preparation: CreationWorkspace | undefined;
    let operation: CreationProgress | undefined;
    let accepted = useLocal ? localCommand(command) : command;
    let result: CommandResult | undefined;
    let failure: CreationFailure | undefined;
    let cleanupComplete = true;
    try {
      await options.engine?.prepareCommand(accepted);
      const fenced = options.store.commandReceipt(command.id, device);
      if (fenced) {
        send({ type: "commandResult", ...fenced });
        return;
      }
      if (!authority()) return;
      if (
        options.engine &&
        (payload.type === "thread.create" || payload.type === "thread.prepare")
      ) {
        const reserved = options.engine.admitCreation(accepted);
        if (typeof reserved === "string") {
          send({ type: "commandResult", commandId: command.id, ok: false, error: reserved });
          return;
        }
        admission = reserved;
        accepted = admission.command;
        if (payload.mode === "worktree" && drafts) {
          // Save the normalized thread ID but retain the original worktree selection for Retry.
          const draft = Command.parse({
            ...command,
            payload: {
              ...payload,
              threadId:
                accepted.payload.type === "thread.create" ||
                accepted.payload.type === "thread.prepare"
                  ? accepted.payload.threadId
                  : undefined,
            },
          });
          operation = await drafts.begin(draft, device, deliver);
          if (how === "continue") operation.skipSetup = true;
          followed.add(command.id);
        }
      }
      if (admission && !useLocal) {
        try {
          preparation = await options.workspaceActions?.prepareCreation(accepted, operation);
        } catch (error) {
          if (
            operation?.action !== "local" ||
            isMutationUnavailable(error) ||
            (error instanceof Error && error.message === "workspace_cleanup_required")
          )
            throw error;
          // Fallback is admitted only after preparation and its owned cleanup have unwound.
          await options.workspaceActions?.localCreation(accepted);
        }
      }
      if (operation?.action === "cancel") throw new Error("worktree_cancelled");
      if (useLocal || operation?.action === "local") {
        await preparation?.release();
        preparation = undefined;
        await options.workspaceActions?.localCreation(accepted);
        admission?.release();
        accepted = localCommand(accepted);
        const reserved = options.engine?.admitCreation(accepted);
        if (typeof reserved === "string") throw new Error(reserved);
        admission = reserved;
        if (admission) accepted = admission.command;
      }
      if (!authority()) return;
      if (
        payload.type === "thread.create" &&
        payload.handoffFrom &&
        !canReadThread(payload.handoffFrom)
      ) {
        result = { commandId: command.id, ok: false, error: "handoff_source_not_found" };
        return;
      }
      await preparation?.verify?.();
      if (!authority()) return;
      result = options.store.recordCommand(command.id, device, () =>
        options.handler.handle(accepted, {
          ...commandContext(options.store),
          ...(admission ? { creationOwner: admission.owner } : {}),
          ...(preparation ? { preparedWorkspace: preparation.workspace } : {}),
        }),
      );
    } catch (error) {
      const cleanupFailed =
        error instanceof Error && error.message === "workspace_cleanup_required";
      if (cleanupFailed) cleanupComplete = false;
      const cancelled =
        operation?.action === "cancel" && !isMutationUnavailable(error) && !cleanupFailed;
      if (!cancelled) {
        failure = creationFailure(error, pullRequestOf(command));
        // The cause is what went wrong; the receipt carries only its public code.
        options.log?.(error instanceof Error && error.cause !== undefined ? error.cause : error);
      }
      result = {
        commandId: command.id,
        ok: false,
        ...(cancelled
          ? { error: "worktree_cancelled" }
          : {
              error: failure?.error ?? "workspace_unavailable",
              code: failure?.error ?? "workspace_unavailable",
              ...(failure ? { title: failure.title, detail: failure.detail } : {}),
            }),
      };
    } finally {
      try {
        await preparation?.release();
      } catch (error) {
        cleanupComplete = false;
        options.log?.(error);
      }
      admission?.release();
      if (operation) {
        if (!result?.ok)
          cleanupComplete =
            cleanupComplete &&
            ((await options.workspaceActions?.creationCleanupSettled(command)) ?? true);
        const state = result?.ok
          ? useLocal || operation.action === "local"
            ? "local"
            : "done"
          : operation.action === "cancel" && result?.error === "worktree_cancelled"
            ? "cancelled"
            : "failed";
        operation.finish(state, cleanupComplete, failure);
        drafts?.release(command.id, Boolean(result?.ok));
        operation.settle(result ?? { commandId: command.id, ok: false, error: "forbidden" });
        followed.delete(command.id);
      }
      if (result) deliver({ type: "commandResult", ...result });
    }
  }
  let flights = 0;
  // SocketInput serializes handlers. Physical creation must leave that queue free for controls.
  function launch(command: Command, device: DeviceId, how: Launch = "worktree"): void {
    if (flights >= 16) {
      send({ type: "commandResult", commandId: command.id, ok: false, error: "workspace_busy" });
      return;
    }
    flights++;
    const task = accept(command, device, how)
      .catch((error) => {
        options.log?.(error);
        deliver({
          type: "commandResult",
          commandId: command.id,
          ok: false,
          error: "workspace_unavailable",
        });
      })
      .finally(() => {
        flights--;
        context.tasks.delete(task);
      });
    context.tasks.add(task);
  }
  return {
    command: {
      types: [
        "thread.create",
        "thread.prepare",
        "thread.send",
        "thread.interrupt",
        "thread.model.set",
        "thread.mode.set",
        "thread.permission.set",
        "interaction.resolve",
        "background_task.stop",
      ],
      scope: () => "operate",
      accept(command, device) {
        const p = command.payload;
        if (
          (p.type === "thread.create" || p.type === "thread.prepare") &&
          p.mode === "worktree" &&
          options.engine &&
          drafts
        )
          launch(command, device);
        else return accept(command, device);
      },
    },
    async handle(message, device) {
      if (message.type !== "worktree.creation.request") return false;
      const response = (
        error?: "not_found" | "forbidden" | "busy" | "cleanup_required" | "settled",
      ) =>
        send({
          type: "worktree.creation.result",
          requestId: message.requestId,
          ok: !error,
          ...(error ? { error } : {}),
        });
      if (!context.authorize(message.action === "get" ? "read" : "operate")) {
        response("forbidden");
        return true;
      }
      const draft = drafts?.get(message.commandId, device);
      if (!draft) {
        response("not_found");
        return true;
      }
      if (message.action === "get") {
        send({
          type: "worktree.creation.result",
          requestId: message.requestId,
          ok: true,
          progress: draft.progress,
        });
        return true;
      }
      if (message.action === "dismiss") {
        response(drafts?.dismiss(message.commandId, device));
        return true;
      }
      if (!draft.progress.actions.includes(message.action)) {
        response("settled");
        return true;
      }
      if (draft.operation?.active) {
        if (message.action === "retry" || message.action === "continue" || draft.operation.action)
          response("busy");
        else {
          draft.operation.stop(message.action);
          response();
        }
        return true;
      }
      if (!draft.progress.cleanupComplete) {
        response("cleanup_required");
        return true;
      }
      if (message.action === "cancel") {
        response("settled");
        return true;
      }
      response();
      launch(draft.command, device, message.action === "retry" ? "worktree" : message.action);
      return true;
    },
    close() {
      for (const id of followed) drafts?.detach(id, deliver);
      followed.clear();
    },
  };
}
