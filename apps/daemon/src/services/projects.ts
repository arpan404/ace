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
    authenticated() {
      if (!options.projects) return;
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
      async accept(command) {
        const result = options.projects
          ? await options.projects.execute(command, context.authorityLease?.("projects") ?? allowed)
          : { commandId: command.id, ok: false, error: "projects_unavailable" };
        if (connected()) send({ type: "commandResult", ...result });
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
