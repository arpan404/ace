import { FileError, type FilesService } from "@ace/files";
import type { FileOperation, FolderPage, ThreadId, WorkspaceId } from "@ace/protocol";
import { aceFilesMissing, type FilesTool } from "./tool.ts";

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
};

/**
 * One folder from ace-files, authorized through the same binding the old `list` uses: a thread's
 * checkout, or a project's folder before a thread exists. Support exports have no folders.
 */
export async function listFolderPage(
  scope: ListingScope,
  tool: FilesTool | undefined,
  request: FolderListingRequest,
): Promise<FolderPage> {
  if (request.scope === "support")
    throw new FileError("FORBIDDEN", "Support exports have no folders");
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
    return await tool.listFolder(root, request.operation.path, {
      limit: request.operation.limit,
      ...(request.operation.cursor === undefined ? {} : { cursor: request.operation.cursor }),
    });
  } finally {
    binding.release?.();
  }
}
