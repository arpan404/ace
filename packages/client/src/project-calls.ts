import { ProjectCloneUrl, ProjectCommand } from "@ace/protocol";
import type { ProjectCalls, ProjectsClient } from "./projects-types.ts";

/*
 * Convenience project commands validate before they enter the client's outbox. The page's
 * RemoteClient loads these on its first project call (ADR 0056). The in-process Client uses
 * them directly; workers use ClientCore and forward the page's validated wire operations.
 */
export function projectCalls(client: ProjectsClient): ProjectCalls {
  return {
    add: (input, options, id) =>
      client.command(ProjectCommand.parse({ type: "workspace.add", ...input }), options, id),
    create: (input, options, id) =>
      client.command(ProjectCommand.parse({ type: "workspace.create", ...input }), options, id),
    clone: (input, options, id) =>
      client.command(
        ProjectCommand.parse({
          type: "workspace.clone",
          ...input,
          url: ProjectCloneUrl.parse(input.url),
        }),
        { timeoutMs: 600_000, ...options },
        id,
      ),
    update: (input, options, id) =>
      client.command(ProjectCommand.parse({ type: "workspace.update", ...input }), options, id),
    rename: (input, options, id) =>
      client.command(ProjectCommand.parse({ type: "workspace.rename", ...input }), options, id),
    remove: (input, options, id) =>
      client.command(ProjectCommand.parse({ type: "workspace.remove", ...input }), options, id),
    inspect: (path, options) =>
      client.request(
        { type: "projects.request", operation: { op: "workspace.inspect", path } },
        options,
      ),
    home: (options) =>
      client.request({ type: "projects.request", operation: { op: "fs.home" } }, options),
    recentFolders: (limit = 20, options) =>
      client.request(
        { type: "projects.request", operation: { op: "fs.recentFolders", limit } },
        options,
      ),
    browse: (input, options) =>
      client.request(
        { type: "projects.request", operation: { op: "fs.browse", ...input } },
        options,
      ),
    search: (input, options) =>
      client.request(
        { type: "projects.request", operation: { op: "fs.search", ...input } },
        options,
      ),
    complete: (input, options) =>
      client.request(
        { type: "projects.request", operation: { op: "fs.complete", ...input } },
        options,
      ),
    validateCloneUrl: (url, options) =>
      client.request(
        { type: "projects.request", operation: { op: "workspace.clone.validate", url } },
        options,
      ),
    cancelClone: (commandId, options) =>
      client.request(
        { type: "projects.request", operation: { op: "workspace.clone.cancel", commandId } },
        options,
      ),
  };
}
