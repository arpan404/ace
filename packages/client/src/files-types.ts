import type { FileOperation, ThreadId } from "@ace/protocol";

export type FileDownloadInput = { threadId?: ThreadId; scope?: "support" } & Extract<
  FileOperation,
  { op: "download" | "artifact.download" | "archive.download" }
>;
export interface FileUploadInput {
  threadId: ThreadId;
  path: string;
  expected: string | null;
  size: number;
  sha256: string;
}
