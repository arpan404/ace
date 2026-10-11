import { SourceControl } from "../source-control.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function startSourceControl({ services, options }: ServiceContext): void {
  if (!services.settings) throw new Error("settings_unavailable");
  services.sourceControl = new SourceControl(
    services.settings,
    options.workspaceActions?.forgeRunner,
  );
}
export function createSourceControlSession(context: SocketContext): SocketService {
  const controllers = new Set<AbortController>();
  return {
    close() {
      for (const controller of controllers) controller.abort();
    },
    handle(message) {
      if (message.type !== "source-control.request") return false;
      const workspaceId = message.operation.workspaceId;
      const allowed = () =>
        context.connected() &&
        context.authorize("read") &&
        (!workspaceId || context.authorize("projects"));
      const service = context.options.sourceControl;
      const cwd = workspaceId ? context.options.store.getWorkspacePath(workspaceId) : service?.root;
      const error = (code: string) =>
        context.send({
          type: "source-control.result",
          requestId: message.requestId,
          result: { kind: "error", code },
        });
      if (!allowed() || !service || !cwd || controllers.size >= 4) {
        error(!allowed() ? "forbidden" : controllers.size >= 4 ? "busy" : "unavailable");
        return true;
      }
      const controller = new AbortController();
      controllers.add(controller);
      const task = service
        .readiness(
          cwd,
          controller.signal,
          workspaceId ? context.options.workspaceActions?.git : undefined,
        )
        .then((readiness) => {
          if (allowed())
            context.send({
              type: "source-control.result",
              requestId: message.requestId,
              result: { kind: "readiness", readiness },
            });
        })
        .catch(() => {
          if (context.connected()) error("unavailable");
        })
        .finally(() => {
          controllers.delete(controller);
        });
      context.tasks.add(task);
      void task.finally(() => context.tasks.delete(task));
      return true;
    },
  };
}
