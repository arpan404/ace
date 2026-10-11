import { GitHubRepositories, ForgeError } from "@ace/forge";
import type { SocketContext, SocketService } from "./socket.ts";

/** Correlated reads are socket-owned; publication commands remain daemon-owned. */
export function createRepositoriesSession(context: SocketContext): SocketService {
  const controllers = new Set<AbortController>();
  let search: AbortController | undefined;
  const allowed = () => context.connected() && context.authorize("projects");
  return {
    close() {
      for (const controller of controllers) controller.abort();
    },
    handle(message) {
      if (message.type !== "repositories.request") return false;
      const source = context.options.sourceControl;
      const projects = context.options.projects;
      const owner = context.device();
      const reply = (result: import("@ace/protocol").HostedRepositoriesResult["result"]) => {
        if (context.connected())
          context.send({ type: "repositories.result", requestId: message.requestId, result });
      };
      if (!allowed() || !source || !projects || !owner || controllers.size >= 4) {
        reply({
          kind: "error",
          code: !allowed() ? "forbidden" : controllers.size >= 4 ? "busy" : "unavailable",
        });
        return true;
      }
      const operation = message.operation;
      const controller = new AbortController();
      if (operation.op === "list") {
        search?.abort();
        search = controller;
      }
      controllers.add(controller);
      const task = (async () => {
        if (operation.op === "list") {
          const input = operation.input;
          const identity = await source.identity(source.root, input.host, controller.signal);
          if (identity.account !== input.account) throw new ForgeError("forbidden");
          const repositories = new GitHubRepositories({
            host: input.host,
            account: input.account,
            runner: identity.runner,
            now: source.now,
          });
          const found = await repositories.list(input, controller.signal);
          controller.signal.throwIfAborted();
          if (allowed())
            reply({
              kind: "repositories",
              repositories: found,
              account: input.account,
              host: input.host,
            });
        } else {
          if (operation.op === "publication.cancel")
            await projects.cancelPublication(operation.workspaceId, owner, allowed);
          const publication = await projects.publicationStatus(operation.workspaceId, allowed);
          if (allowed()) reply({ kind: "publication", publication });
        }
      })()
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            reply({
              kind: "error",
              code: !allowed()
                ? "forbidden"
                : error instanceof ForgeError
                  ? `forge_${error.kind}`
                  : "repository_unavailable",
            });
        })
        .finally(() => {
          controllers.delete(controller);
          if (search === controller) search = undefined;
        });
      context.tasks.add(task);
      void task.then(
        () => context.tasks.delete(task),
        () => context.tasks.delete(task),
      );
      return true;
    },
  };
}
