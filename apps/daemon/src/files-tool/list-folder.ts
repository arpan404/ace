import { FileError, type FilesService } from "@ace/files";
import type { FileOperation, FolderPage, ThreadId, WorkspaceId } from "@ace/protocol";
import { aceFilesMissing } from "./tool.ts";

/** What a folder listing needs from ace-files, so a test can stand in for the process. */
export type FolderLister = {
  listFolder(
    path: string,
    dir: string,
    options: {
      limit?: number | undefined;
      cursor?: string | undefined;
      signal?: AbortSignal | undefined;
    },
  ): Promise<FolderPage>;
};

/** The resolved service a scoped file request answers from; what both socket paths return. */
export type ListingScope = (
  threadId: ThreadId | undefined,
  scope: "support" | undefined,
  operation: FileOperation | undefined,
  workspaceId: WorkspaceId | undefined,
) => Promise<{
  service: FilesService;
  root?: string | undefined;
  release?(): void;
  allowed(access: "read" | "operate"): boolean;
}>;

export type FolderListingRequest = {
  threadId: ThreadId | undefined;
  scope: "support" | undefined;
  workspaceId: WorkspaceId | undefined;
  operation: Extract<FileOperation, { op: "list.folder" }>;
  /** One socket's cancellation; a relay's task is bounded by its listing cap instead. */
  signal?: AbortSignal | undefined;
};

/**
 * One folder from ace-files, authorized through the same binding the old `list` uses: a thread's
 * checkout, or a project's folder before a thread exists. Support exports have no folders.
 */
export async function listFolderPage(
  scope: ListingScope,
  tool: FolderLister | undefined,
  request: FolderListingRequest,
): Promise<FolderPage> {
  if (request.scope === "support")
    throw new FileError("FORBIDDEN", "Support exports have no folders");
  if (request.threadId === undefined && request.workspaceId === undefined)
    throw new FileError("FORBIDDEN", "Folder listing needs a thread or a project folder");
  const binding = await scope(
    request.threadId,
    request.scope,
    request.operation,
    request.workspaceId,
  );
  try {
    if (!binding.allowed("read")) throw new FileError("FORBIDDEN", "File access denied");
    const root = binding.root;
    if (root === undefined)
      throw new FileError("FORBIDDEN", "Folder listing needs a thread or project folder");
    if (!tool) throw aceFilesMissing();
    const page = await tool.listFolder(root, request.operation.path, {
      limit: request.operation.limit,
      ...(request.operation.cursor === undefined ? {} : { cursor: request.operation.cursor }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    // The listing crossed an await: a socket can close, a device lose its grant or a thread
    // change its checkout while ace-files walks, so the binding decides again before any entry
    // leaves the daemon.
    if (!binding.allowed("read")) throw new FileError("FORBIDDEN", "File access denied");
    return page;
  } finally {
    binding.release?.();
  }
}
