import { loadHostId } from "../local-files.ts";
import { computerName } from "../computer-name.ts";
import { cleanRetiredWorktrees } from "../retired-worktrees.ts";
import { actionErrorCode } from "../action-errors.ts";
import { logError } from "@ace/diagnostics";
import { WorkspaceRefresh } from "../workspace-refresh.ts";
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
  const refresh = new WorkspaceRefresh(store, workspace, now, undefined, (error) =>
    log.log("debug", "Workspace metadata unavailable", logError(error)),
  );
  resources.own(() => refresh.close());
}
export function createWorkspaceActionsSession(context: SocketContext): SocketService {
  const { options, authorize, send, canReadThread, connected, tasks } = context;
  let reads = 0;
  return {
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
      if (!authorize("read") || ("threadId" in op && !canReadThread(op.threadId))) {
        send({
          type: "workspace.result",
          requestId: message.requestId,
          result: { kind: "error", code: "forbidden" },
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
      const task = options.workspaceActions
        .read(message)
        .then((result) => {
          if (
            connected() &&
            authorize("read") &&
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
        });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return true;
    },
  };
}
