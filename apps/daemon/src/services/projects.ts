import { ProjectCommands, ProjectsResult } from "@ace/protocol";
import { Projects } from "../projects.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function startProjects({ store, services, options, now, resources }: ServiceContext): void {
  const projects = new Projects(store, now, {
    ...options.projects,
    roots:
      options.projects?.roots ??
      (async () => {
        if (!services.settings) throw new Error("settings_unavailable");
        return (await services.settings.get("projects.roots")).value;
      }),
    hasOwnedWork: (id) => services.workspaceActions?.hasOwnedWork(id) ?? false,
  });
  services.projects = projects;
  resources.own(() => projects.close());
}
export function createProjectsSession(context: SocketContext): SocketService {
  const { options, authorize, connected, device, send, tasks } = context;
  let reads = 0;
  let stops: (() => void)[] = [];
  const allowed = () => connected() && authorize("projects");
  return {
    authenticated(kind) {
      // Project changes belong on the main channel; a devices or files channel can't parse them.
      if (kind !== undefined || !options.projects) return;
      stops = [
        options.projects.subscribe((change) => {
          if (allowed()) send(change);
        }),
        options.projects.onProgress((owner, progress) => {
          if (allowed() && device() === owner) send(progress);
        }),
      ];
    },
    close() {
      for (const stop of stops) stop();
    },
    command: {
      types: ProjectCommands.map((schema) => schema.shape.type.value),
      scope: () => "projects",
      // Not awaited: a clone runs for minutes, and the socket's next messages (its cancel, the
      // client's reads) must not queue behind it. The receipt goes out when it ends.
      accept(command) {
        const projects = options.projects;
        if (!projects) {
          send({
            type: "commandResult",
            commandId: command.id,
            ok: false,
            error: "projects_unavailable",
          });
          return;
        }
        const task = projects
          .execute(command, context.authorityLease?.("projects") ?? allowed)
          .catch(() => ({ commandId: command.id, ok: false, error: "project_failed" }))
          .then((result) => {
            if (connected()) send({ type: "commandResult", ...result });
          });
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      },
    },
    handle(message) {
      if (message.type !== "projects.request") return false;
      const owner = device();
      if (!allowed() || !owner || !options.projects || reads >= 8) {
        send({
          type: "projects.result",
          requestId: message.requestId,
          result: {
            kind: "error",
            code: !allowed() ? "forbidden" : reads >= 8 ? "busy" : "unavailable",
          },
        });
        return true;
      }
      reads++;
      const task = options.projects
        .read(message, owner, allowed)
        .then((result) => {
          if (connected()) send(ProjectsResult.parse(result));
        })
        .finally(() => {
          reads--;
        });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return true;
    },
  };
}
