import type { z } from "zod";
import {
  ProjectCommand,
  ProjectCloneUrl,
  type ProjectsRequest,
  ProjectsResult,
  WorkspaceChanged,
  WorkspaceCloneProgress,
  CommandResult,
} from "@ace/protocol";
import type { CommandPayload, ServerMessage } from "@ace/protocol";
import type { ServiceRequest, ServiceResponse } from "./service-requests.ts";
import type { RequestOptions } from "./types.ts";

type Input<T extends ProjectCommand["type"]> = Omit<
  Extract<z.input<typeof ProjectCommand>, { type: T }>,
  "type"
>;
type BrowseInput = Omit<
  Extract<z.input<typeof ProjectsRequest>["operation"], { op: "fs.browse" }>,
  "op"
>;
export interface ProjectsApi {
  add(
    input: Input<"workspace.add">,
    options?: RequestOptions,
    commandId?: string,
  ): Promise<CommandResult>;
  create(
    input: Input<"workspace.create">,
    options?: RequestOptions,
    commandId?: string,
  ): Promise<CommandResult>;
  clone(
    input: Input<"workspace.clone">,
    options?: RequestOptions,
    commandId?: string,
  ): Promise<CommandResult>;
  rename(
    input: Input<"workspace.rename">,
    options?: RequestOptions,
    commandId?: string,
  ): Promise<CommandResult>;
  remove(
    input: Input<"workspace.remove">,
    options?: RequestOptions,
    commandId?: string,
  ): Promise<CommandResult>;
  inspect(path: string, options?: RequestOptions): Promise<ProjectsResult>;
  home(options?: RequestOptions): Promise<ProjectsResult>;
  recentFolders(limit?: number, options?: RequestOptions): Promise<ProjectsResult>;
  browse(input: BrowseInput, options?: RequestOptions): Promise<ProjectsResult>;
  cancelClone(commandId: string, options?: RequestOptions): Promise<ProjectsResult>;
  onChanged(listener: (change: WorkspaceChanged) => void): () => void;
  onCloneProgress(listener: (progress: WorkspaceCloneProgress) => void): () => void;
}
/** Both clients use the same helpers; worker calls forward through command/request/onMessage. */
export function projectsApi(client: {
  command(payload: CommandPayload, options?: RequestOptions, id?: string): Promise<CommandResult>;
  request<Q extends ServiceRequest>(
    input: Q,
    options?: RequestOptions,
  ): Promise<ServiceResponse<Q>>;
  onMessage(listener: (message: ServerMessage) => void): () => void;
}): ProjectsApi {
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
    cancelClone: (commandId, options) =>
      client.request(
        { type: "projects.request", operation: { op: "workspace.clone.cancel", commandId } },
        options,
      ),
    onChanged: (listener) =>
      client.onMessage((message) => {
        if (message.type === "workspace.changed") listener(message);
      }),
    onCloneProgress: (listener) =>
      client.onMessage((message) => {
        if (message.type === "workspace.clone.progress") listener(message);
      }),
  };
}
