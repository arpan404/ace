import type { FileOperation, ThreadId, WorkspaceId } from "@ace/protocol";

/** One scope: a thread's checkout, a registered project's own folder (read-only), or support. */
export type FileDownloadInput = {
  threadId?: ThreadId;
  workspaceId?: WorkspaceId;
  scope?: "support";
} & Extract<FileOperation, { op: "download" | "artifact.download" | "archive.download" }>;
export interface FileUploadInput {
  threadId: ThreadId;
  path: string;
  expected: string | null;
  size: number;
  sha256: string;
}
