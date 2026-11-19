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

/** Who asks to read a checkout through ace-files: a thread's, or a project's before a thread. */
export type CheckoutReadRequest = {
  threadId?: ThreadId | undefined;
  scope?: "support" | undefined;
  workspaceId?: WorkspaceId | undefined;
  operation: FileOperation;
};

/**
 * Run `task` on a checkout an ace-files read may touch, authorized through the same binding the
 * old `list` uses: a thread's checkout, or a project's folder before a thread exists. Support
 * exports have no checkout. The binding is held for the task and decides again after it, since
 * a socket can close, a device lose its grant or a thread change its checkout while ace-files
 * works. `allowed` lets a long task (a search) check the grant before each thing it sends.
 */
export async function readCheckout<T>(
  scope: ListingScope,
  request: CheckoutReadRequest,
  task: (root: string, allowed: () => boolean) => Promise<T>,
): Promise<T> {
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
    const result = await task(root, () => binding.allowed("read"));
    if (!binding.allowed("read")) throw new FileError("FORBIDDEN", "File access denied");
    return result;
  } finally {
    binding.release?.();
  }
}

/** One folder from ace-files, authorized as every checkout read is. */
export function listFolderPage(
  scope: ListingScope,
  tool: FolderLister | undefined,
  request: FolderListingRequest,
): Promise<FolderPage> {
  return readCheckout(scope, request, (root) => {
    if (!tool) throw aceFilesMissing();
    return tool.listFolder(root, request.operation.path, {
      limit: request.operation.limit,
      ...(request.operation.cursor === undefined ? {} : { cursor: request.operation.cursor }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  });
}
