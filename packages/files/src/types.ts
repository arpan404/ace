import type { Stats } from "node:fs";
import type { WorkspaceFileChange } from "@ace/protocol";

export const CHUNK_SIZE = 64 * 1024;
export const MAX_CREDITS = 8;
export class FileError extends Error {
  readonly code: string;
  readonly current: string | null | undefined;
  constructor(code: string, message: string, current?: string | null) {
    super(message);
    this.code = code;
    this.current = current;
  }
}
export function version(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
export function checkVersion(current: string | null, expected: string | null): void {
  if (current !== expected) throw new FileError("CONFLICT", "File version changed", current);
}
export interface FilesOptions {
  exclusiveRename?: import("./exclusive-rename.ts").ExclusiveRename;
  workspace: string;
  dataDir: string;
  artifactRoots?: string[];
  now(): number;
  id(): string;
  authorize(device: string, capability: "files.read" | "files.write"): boolean;
  exportRaw?(device: string, blobRef: string, assertAuthorized: () => void): Promise<string>;
  exportOutput?(device: string, streamId: string, assertAuthorized: () => void): Promise<string>;
  onChange?(change: WorkspaceFileChange): void;
  maxTransfers?: number;
  maxUploadBytes?: number;
  maxReservedBytes?: number;
  maxTrashBytes?: number;
  maxArtifactBytes?: number;
  retentionMs?: number;
}
export interface Download {
  size: number | null;
  offset: number;
  validator: string;
  chunks: AsyncGenerator<Buffer>;
  close(): Promise<void>;
}
export function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "IO_ERROR";
}
