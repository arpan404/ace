import type { Stats } from "node:fs";
import type { WorkspaceFileChange } from "@ace/protocol";

import { FileError } from "./portable-types.ts";
export { CHUNK_SIZE, MAX_CREDITS, FileError } from "./portable-types.ts";
export function version(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
export function checkVersion(current: string | null, expected: string | null): void {
  if (current !== expected) throw new FileError("CONFLICT", "File version changed", current);
}
export interface FilesOptions {
  workspaceRuntime?: import("@ace/workspace").WorkspaceRuntime;
  /**
   * The port a checkout's reads and writes go through. The daemon passes ace-files (ADR 0178);
   * left out, the service uses its own confined Node I/O, as its tests and the daemon's private
   * registries do.
   */
  workspaceIo?: import("./io.ts").FilesIo;
  exclusiveRename?: import("./exclusive-rename.ts").ExclusiveRename;
  workspace: string;
  dataDir: string;
  artifactRoots?: string[];
  now(): number;
  id(): string;
  authorize(device: string, capability: "files.read" | "files.write"): boolean;
  exportSupport?(
    device: string,
    assertAuthorized: () => void,
    includeThreads?: boolean,
  ): Promise<string>;
  exportRaw?(device: string, blobRef: string, assertAuthorized: () => void): Promise<string>;
  exportOutput?(device: string, streamId: string, assertAuthorized: () => void): Promise<string>;
  onChange?(change: WorkspaceFileChange): void;
  onUploadRecovery?(notice: { uploadId: string; path: string; reason: string }): void;
  maxTransfers?: number;
  transferIdleMs?: number;
  scheduleTimeout?(callback: () => void, milliseconds: number): () => void;
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
