import { FileError, type FilesService } from "@ace/files";
import type { FileOperation, ThreadId, WorkspaceId } from "@ace/protocol";
import { fileExportSource } from "./file-export-source.ts";
import { projectFilesBinding } from "./project-files-binding.ts";
import type { SocketContext } from "./services/socket.ts";

/** One request's service, the checkout it reads, and who may read or write it. */
export type FilesBinding = {
  service: FilesService;
  /** The checkout a thread or project request reads; absent for support and artifact sources. */
  root?: string | undefined;
  release?(): void;
  allowed(access: "read" | "operate"): boolean;
  /** What the service runs instead of the request, when the binding translated it. */
  operation?: FileOperation;
};

export type FilesScope = (
  threadId: ThreadId | undefined,
  scope: "support" | undefined,
  operation: FileOperation | undefined,
  workspaceId: WorkspaceId | undefined,
) => Promise<FilesBinding>;

/**
 * Which service answers a scoped file request, with the same checks for every path into files:
 * the chunk channel, folder listings and watches. A thread reads its own checkout, a project its
 * registered folder (read-only), a support request the support registry; export identifiers
 * carry their own source, which the request may not widen.
 */
export function filesScope(context: SocketContext): FilesScope {
  const readableSource = (source: ThreadId | undefined) =>
    source === undefined ||
    (context.canReadThread(source) && context.options.store.hasLiveThread(source));
  return async (threadId, scope, operation, workspaceId) => {
    const files = context.options.threadFiles;
    if (workspaceId !== undefined) {
      if (!files) throw new Error("Project files unavailable");
      return projectFilesBinding(
        files,
        workspaceId,
        operation,
        () => context.connected() && context.authorize("read"),
      );
    }
    if (scope === "support") {
      const service = context.options.supportFiles;
      if (!service) throw new Error("Support export unavailable");
      return { service, allowed: (access) => context.connected() && context.authorize(access) };
    }
    if (!threadId || !files || !context.canReadThread(threadId))
      throw new Error("File thread unavailable");
    if (operation?.op === "link.download")
      return files.linkedFiles.bind(
        threadId,
        operation,
        () => context.connected() && context.authorize("read") && context.canReadThread(threadId),
      );
    if (operation?.op === "artifact.download" && operation.artifactId.startsWith("browser-")) {
      const artifacts = files.browserArtifacts;
      if (!artifacts.owns(threadId, operation.artifactId))
        throw new Error("Artifact is not readable by this thread");
      return {
        service: await artifacts.get(),
        allowed: (access) =>
          access === "read" &&
          context.connected() &&
          context.authorize("read") &&
          context.canReadThread(threadId) &&
          artifacts.owns(threadId, operation.artifactId),
      };
    }
    const root = files.root(threadId);
    const { service, release } = await files.acquire(threadId);
    let source: ThreadId | undefined;
    try {
      source = fileExportSource(service, context.options.store, operation);
      if (source !== undefined && (source !== threadId || !readableSource(source)))
        throw new FileError("FORBIDDEN", "Export source is not readable by this thread");
    } catch (error) {
      release();
      throw error;
    }
    return {
      root,
      service,
      release,
      allowed: (access) =>
        context.connected() &&
        context.authorize(access) &&
        context.canReadThread(threadId) &&
        files.matches(threadId, root) &&
        readableSource(source),
    };
  };
}
