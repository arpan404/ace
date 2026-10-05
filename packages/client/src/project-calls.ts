import { ProjectCloneUrl, ProjectCommand } from "@ace/protocol";
import type { ProjectCalls, ProjectsClient } from "./projects-types.ts";

/*
 * The project commands and requests, with the schemas that validate commands before they are
 * sent or kept in an outbox. The page's `RemoteClient` loads this module on its first project
 * call (`deferredProjectsApi`). `Client` (the client worker's, or the page's fallback) takes it
 * eagerly: there classic Zod and the project command schemas are loaded for the core command
 * union anyway, so these calls add a tenth of a kilobyte, where a chunk of their own would add
 * over half a kilobyte (ADR 0056).
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
