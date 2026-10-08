import { Command, type DeviceId, type CommandResult } from "@ace/protocol";
import { isMutationUnavailable } from "@ace/git";
import { commandContext } from "../commands.ts";
import { WorktreeBaseError } from "../worktree-base-resolution.ts";
import type { CreationProgress } from "../creation-progress.ts";
import type { CreationAdmission } from "../engine/creation-admissions.ts";
import type { CreationWorkspace } from "../creation-workspace.ts";
import type { SocketContext, SocketService } from "./socket.ts";

function localCommand(command: Command): Command {
  const p = command.payload;
  if (p.type !== "thread.create" && p.type !== "thread.prepare") return command;
  const { base: _base, baseBranch: _baseBranch, ...rest } = p;
  return Command.parse({ ...command, payload: { ...rest, mode: "local" } });
}
export function createEngineSession(context: SocketContext): SocketService {
  const { options, send, canReadThread } = context;
  const owned = new Set<CreationProgress>();
  const drafts = options.workspaceActions?.creationDrafts;
  async function accept(command: Command, device: DeviceId, useLocal = false): Promise<void> {
    const payload = command.payload;
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
    let admission: CreationAdmission | undefined;
    let preparation: CreationWorkspace | undefined;
    let operation: CreationProgress | undefined;
    let accepted = useLocal ? localCommand(command) : command;
    let result: CommandResult | undefined;
    let cleanupComplete = true;
    try {
      await options.engine?.prepareCommand(accepted);
      if (!context.connected() || !context.authorize("operate")) return;
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
          operation = drafts.begin(draft, device, (message) => {
            if (context.connected()) send(message);
          });
          owned.add(operation);
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
      if (!context.connected() || !context.authorize("operate")) return;
      if (payload.type === "interaction.resolve") {
        const interaction = options.store.getInteraction(payload.interactionId);
        if (
          interaction?.raw.some((raw) => raw.type === "ace.browser.origin") &&
          !canReadThread(interaction.threadId)
        ) {
          result = { commandId: command.id, ok: false, error: "browser_thread_access_denied" };
          return;
        }
      }
      if (
        payload.type === "thread.create" &&
        payload.handoffFrom &&
        !canReadThread(payload.handoffFrom)
      ) {
        result = { commandId: command.id, ok: false, error: "handoff_source_not_found" };
        return;
      }
      result = options.store.recordCommand(command.id, device, () =>
        options.handler.handle(accepted, {
          ...commandContext(options.store),
          ...(admission ? { creationOwner: admission.owner } : {}),
          ...(preparation ? { preparedWorkspace: preparation.workspace } : {}),
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "workspace_cleanup_required" &&
        error.cause !== undefined
      )
        options.log?.(error.cause);
      cleanupComplete =
        !isMutationUnavailable(error) &&
        !(error instanceof Error && error.message === "workspace_cleanup_required");
      result = {
        commandId: command.id,
        ok: false,
        ...(operation?.action === "cancel" && cleanupComplete
          ? { error: "worktree_cancelled" }
          : error instanceof WorktreeBaseError
            ? {
                error: error.code,
                code: error.code,
                title: error.title,
                detail: "We couldn't create the worktree. Try again or use the local checkout.",
              }
            : { error: "workspace_unavailable" }),
      };
    } finally {
      admission?.release();
      try {
        await preparation?.release();
      } catch (error) {
        cleanupComplete = false;
        options.log?.(error);
      }
      if (operation) {
        const state = result?.ok
          ? useLocal || operation.action === "local"
            ? "local"
            : "done"
          : operation.action === "cancel" && cleanupComplete
            ? "cancelled"
            : "failed";
        operation.finish(state, cleanupComplete);
        owned.delete(operation);
        drafts?.release(command.id, Boolean(result?.ok));
      }
      if (result && context.connected()) send({ type: "commandResult", ...result });
    }
  }
  let flights = 0;
  // SocketInput serializes handlers. Physical creation must leave that queue free for controls.
  function launch(command: Command, device: DeviceId, useLocal = false): void {
    if (flights >= 16) {
      send({ type: "commandResult", commandId: command.id, ok: false, error: "workspace_busy" });
      return;
    }
    flights++;
    const task = accept(command, device, useLocal)
      .catch((error) => {
        options.log?.(error);
        if (context.connected())
          send({
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
      if (draft.operation?.active) {
        if (message.action === "retry" || draft.operation.action) response("busy");
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
      launch(draft.command, device, message.action === "local");
      return true;
    },
    close() {
      for (const operation of owned) if (!operation.action) operation.stop("cancel");
    },
  };
}
