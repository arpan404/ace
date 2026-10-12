import { createWritingCli } from "../source-control-cli.ts";
import type { CreationProgress } from "../creation-progress.ts";
import { loadHostId } from "../local-files.ts";
import { computerName } from "../computer-name.ts";
import { cleanRetiredWorktrees } from "../retired-worktrees.ts";
import { actionErrorCode } from "../action-errors.ts";
import { logError } from "@ace/diagnostics";
import { WorkspaceRefresh } from "../workspace-refresh.ts";
import { PullRequestAutoLink } from "../pr-auto-link.ts";
import { ThreadId, ForgeCommand, WorkspaceCommands, WorkspaceActionResult } from "@ace/protocol";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
export async function startWorkspaceActions({
  store,
  config,
  services,
  resources,
  now,
  options,
  log,
}: ServiceContext): Promise<void> {
  await cleanRetiredWorktrees(
    store,
    config.dataDir,
    options.workspaceActions?.git ?? {},
    (path, error) => log.log("warn", `Retained former Offshift worktree: ${path}`, logError(error)),
  );
  const workspace = new WorkspaceRuntime(store, config.dataDir, now, {
    ...options.workspaceActions,
    ...(services.sourceControl ? { sourceControl: services.sourceControl } : {}),
    writingCli:
      options.workspaceActions?.writingCli ??
      createWritingCli({
        configuration: (provider) => services.providerConfigurations?.for(provider),
        ...(options.engine?.clock ? { clock: options.engine.clock } : {}),
      }),
    machine: options.workspaceActions?.machine ?? {
      host: loadHostId(config.dataDir),
      name: await computerName(),
    },
    reconcileThread: async (id) => {
      await services.engine?.reconcileThread(id);
    },
    changeWorkspace: (id, commandId, effect, reservation, commit) => {
      if (!services.engine) throw new Error("engine_unavailable");
      return services.engine.changeWorkspace(id, commandId, effect, reservation, commit);
    },
  });
  services.workspaceActions = workspace;
  services.canReadThread = (_device, id) =>
    Boolean(store.getThread(id)) && store.getThread(id)?.deletedAt === undefined;
  resources.own(() => workspace.close());
  const prLinks = new PullRequestAutoLink(store, workspace, (error) =>
    log.log("debug", "Created pull request could not be linked", logError(error)),
  );
  resources.own(() => prLinks.close());
  const refresh = new WorkspaceRefresh(store, workspace, now, undefined, (error) =>
    log.log("debug", "Workspace metadata unavailable", logError(error)),
  );
  resources.own(() => refresh.close());
}
export function createWorkspaceActionsSession(context: SocketContext): SocketService {
  const { options, authorize, send, canReadThread, connected, tasks } = context;
  let reads = 0;
  const lifetime = new AbortController();
  const generations = new Map<string, { threadId: string; controller: AbortController }>();
  const preparations = new Set<CreationProgress>();
  return {
    close() {
      lifetime.abort();
      for (const entry of generations.values()) entry.controller.abort();
      generations.clear();
      for (const progress of preparations) if (!progress.action) progress.stop("cancel");
    },
    command: {
      types: [
        ...WorkspaceCommands.map((schema) => schema.shape.type.value),
        ...ForgeCommand.options.map((schema) => schema.shape.type.value),
      ],
      scope: (command) => (command.payload.type === "forge.pr.status" ? "read" : "operate"),
      async accept(command) {
        const p = command.payload;
        const id = "threadId" in p ? p.threadId : "link" in p ? p.link.threadId : undefined;
        if (!options.workspaceActions || !id || !canReadThread(ThreadId.parse(id))) {
          send({
            type: "commandResult",
            commandId: command.id,
            ok: false,
            error: "workspace_unavailable",
          });
          return;
        }
        if (p.type === "forge.pr.worktree") {
          const runtime = options.workspaceActions;
          const receipt = context.options.store.commandReceipt(command.id, command.deviceId);
          if (receipt && receipt.error !== "client_action_pending") {
            send({ type: "commandResult", ...receipt });
            return;
          }
          const existing = runtime.creationDrafts.get(command.id, command.deviceId);
          if (existing?.operation?.active) {
            send({ type: "worktree.creation.progress", ...existing.progress });
            const replay = runtime
              .execute(
                command,
                () => connected() && authorize("operate") && canReadThread(p.threadId),
                existing.operation,
              )
              .then((result) => {
                if (connected()) send({ type: "commandResult", ...result });
              })
              .finally(() => tasks.delete(replay));
            tasks.add(replay);
            return;
          }
          let progress: CreationProgress;
          try {
            progress = await runtime.creationDrafts.begin(command, command.deviceId, (message) => {
              if (connected()) send(message);
            });
          } catch (error) {
            send({
              type: "commandResult",
              commandId: command.id,
              ok: false,
              error: actionErrorCode(error),
            });
            return;
          }
          preparations.add(progress);
          const task = runtime
            .execute(
              command,
              () => connected() && authorize("operate") && canReadThread(p.threadId),
              progress,
            )
            .then((result) => {
              progress.finish(
                result.ok ? "done" : progress.action === "cancel" ? "cancelled" : "failed",
                result.error !== "git_quarantined" && result.error !== "workspace_cleanup_required",
              );
              runtime.creationDrafts.release(command.id, result.ok);
              if (connected()) send({ type: "commandResult", ...result });
            })
            .catch((error: unknown) => {
              progress.finish("failed", false);
              runtime.creationDrafts.release(command.id, false);
              if (connected())
                send({
                  type: "commandResult",
                  commandId: command.id,
                  ok: false,
                  error: actionErrorCode(error),
                });
            })
            .finally(() => {
              preparations.delete(progress);
              tasks.delete(task);
            });
          tasks.add(task);
          return;
        }
        const result = await options.workspaceActions.execute(
          command,
          () =>
            connected() &&
            authorize(p.type === "forge.pr.status" ? "read" : "operate") &&
            canReadThread(ThreadId.parse(id)),
        );
        if (connected()) send({ type: "commandResult", ...result });
      },
    },
    handle(message) {
      if (message.type !== "workspace.request") return false;
      const op = message.operation;
      const scope =
        op.op === "git.draft.generate" || op.op === "git.draft.cancel" ? "operate" : "read";
      if (!authorize(scope) || ("threadId" in op && !canReadThread(op.threadId))) {
        send({
          type: "workspace.result",
          requestId: message.requestId,
          result: { kind: "error", code: "forbidden" },
        });
        return true;
      }
      if (op.op === "git.draft.cancel") {
        const entry = generations.get(op.generationId);
        if (entry?.threadId === op.threadId) entry.controller.abort();
        send({
          type: "workspace.result",
          requestId: message.requestId,
          result: { kind: "draftCancelled" },
        });
        return true;
      }
      if (
        op.op === "git.draft.generate" &&
        (!context.maintenance.admit() || generations.has(op.input.generationId))
      ) {
        send({
          type: "workspace.result",
          requestId: message.requestId,
          result: { kind: "error", code: "draft_busy" },
        });
        return true;
      }
      if (!options.workspaceActions || reads >= 8) {
        send({
          type: "workspace.result",
          requestId: message.requestId,
          result: { kind: "error", code: reads >= 8 ? "busy" : "unavailable" },
        });
        return true;
      }
      reads++;
      const controller = new AbortController();
      if (op.op === "git.draft.generate")
        generations.set(op.input.generationId, { threadId: op.threadId, controller });
      const task = options.workspaceActions
        .read(message, AbortSignal.any([lifetime.signal, controller.signal]))
        .then((result) => {
          if (
            connected() &&
            authorize(scope) &&
            (!("threadId" in op) || canReadThread(op.threadId))
          )
            send(WorkspaceActionResult.parse(result));
        })
        .catch((error: unknown) =>
          send({
            type: "workspace.result",
            requestId: message.requestId,
            result: { kind: "error", code: actionErrorCode(error) },
          }),
        )
        .finally(() => {
          reads--;
          if (op.op === "git.draft.generate") generations.delete(op.input.generationId);
        });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return true;
    },
  };
}
