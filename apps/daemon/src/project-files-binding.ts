import { FileError, type FilesService } from "@ace/files";
import type { FileOperation, WorkspaceId } from "@ace/protocol";
import type { FilesWorkspaces } from "./files-workspaces.ts";

/** What a device may do in a project's folder before any thread exists: read, nothing else. */
const reads: ReadonlySet<string> = new Set(["list", "stat", "read", "download"]);

/**
 * A `files.request` binding for a registered project's own folder. Read-only: listing, stat, read and
 * download, with the same confinement as a thread's checkout (the root's `FilesService`).
 * `readable` is the socket's live read grant; the binding stays valid only while it holds and
 * the project is still registered at the same folder.
 */
export async function projectFilesBinding(
  files: FilesWorkspaces,
  workspaceId: WorkspaceId,
  operation: FileOperation | undefined,
  readable: () => boolean,
): Promise<{
  service: FilesService;
  release?(): void;
  allowed(access: "read" | "operate"): boolean;
  operation?: FileOperation;
}> {
  if (operation?.op === "forge.media.download") {
    // Media the daemon fetched for this project's forge text (ADR 0096), by hash.
    const registered = () => {
      try {
        files.projectRoot(workspaceId);
        return true;
      } catch {
        return false;
      }
    };
    if (!registered()) throw new FileError("NOT_FOUND", "Project unavailable");
    return files.forgeMedia.bind(workspaceId, operation, () => readable() && registered());
  }
  if (!operation || !reads.has(operation.op))
    throw new FileError("FORBIDDEN", "A project's files are read-only before a thread exists");
  if (!readable()) throw new FileError("FORBIDDEN", "File access denied");
  let root: string;
  try {
    root = files.projectRoot(workspaceId);
  } catch {
    throw new FileError("NOT_FOUND", "Project unavailable");
  }
  const { service, release } = await files.acquireProject(workspaceId);
  return {
    service,
    release,
    allowed: (access) => access === "read" && readable() && files.matchesProject(workspaceId, root),
  };
}
