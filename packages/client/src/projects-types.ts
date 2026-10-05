import type { z } from "zod";
import type {
  CommandPayload,
  CommandResult,
  ProjectCommand,
  ProjectsRequest,
  ProjectsResult,
  ServerMessage,
  WorkspaceChanged,
  WorkspaceCloneProgress,
} from "@ace/protocol";
import type { ServiceRequest, ServiceResponse } from "./service-requests.ts";
import type { RequestOptions } from "./types.ts";

type Input<T extends ProjectCommand["type"]> = Omit<
  Extract<z.input<typeof ProjectCommand>, { type: T }>,
  "type"
>;
type PickerInput<T extends ProjectsRequest["operation"]["op"]> = Omit<
  Extract<z.input<typeof ProjectsRequest>["operation"], { op: T }>,
  "op"
>;
type BrowseInput = Omit<
  Extract<z.input<typeof ProjectsRequest>["operation"], { op: "fs.browse" }>,
  "op"
>;
/** The project calls that validate or reach the daemon; they load on a client's first one. */
export interface ProjectCalls {
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
  search(input: PickerInput<"fs.search">, options?: RequestOptions): Promise<ProjectsResult>;
  complete(input: PickerInput<"fs.complete">, options?: RequestOptions): Promise<ProjectsResult>;
  validateCloneUrl(url: string, options?: RequestOptions): Promise<ProjectsResult>;
  cancelClone(commandId: string, options?: RequestOptions): Promise<ProjectsResult>;
}
export interface ProjectsApi extends ProjectCalls {
  onChanged(listener: (change: WorkspaceChanged) => void): () => void;
  onCloneProgress(listener: (progress: WorkspaceCloneProgress) => void): () => void;
}
/** What the project helpers need of a client: `Client` and the worker's `RemoteClient` alike. */
export interface ProjectsClient {
  command(payload: CommandPayload, options?: RequestOptions, id?: string): Promise<CommandResult>;
  request<Q extends ServiceRequest>(
    input: Q,
    options?: RequestOptions,
  ): Promise<ServiceResponse<Q>>;
  onMessage(listener: (message: ServerMessage) => void): () => void;
}
/** The module with the project calls (`@ace/client/project-calls`), which loads on demand. */
export interface ProjectCallsModule {
  projectCalls(client: ProjectsClient): ProjectCalls;
}
