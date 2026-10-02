export type WorkspaceErrorCode =
  | "INVALID_PATH"
  | "PATH_ESCAPE"
  | "PATH_CHANGED"
  | "NOT_FOUND"
  | "NOT_DIRECTORY"
  | "NOT_FILE"
  | "PERMISSION_DENIED"
  | "IO_ERROR"
  | "INVALID_ARGUMENT"
  | "INVALID_CURSOR"
  | "LIMIT_EXCEEDED"
  | "ABORTED"
  | "SEARCH_FAILED";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WorkspaceError";
    this.code = code;
  }
}
export function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}
export function failure(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const code = errorCode(error);
  const mapped =
    code === "ENOENT"
      ? "NOT_FOUND"
      : code === "ENOTDIR"
        ? "NOT_DIRECTORY"
        : code === "EACCES" || code === "EPERM"
          ? "PERMISSION_DENIED"
          : code === "ELOOP"
            ? "PATH_CHANGED"
            : "IO_ERROR";
  return new WorkspaceError(mapped, error instanceof Error ? error.message : String(error), error);
}
export function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new WorkspaceError(
      "INVALID_ARGUMENT",
      `${name} must be an integer between ${min} and ${max}`,
    );
  }
  return value;
}
export function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkspaceError("ABORTED", "Workspace operation cancelled");
}
export interface Entry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mtime: number;
  ignored: boolean;
}
export interface ListOptions {
  dir: string;
  depth?: number;
  includeIgnored?: boolean;
  limit?: number;
  cursor?: string;
}
export interface ListResult {
  entries: Entry[];
  nextCursor: string | null;
  truncated: boolean;
}
export interface ReadOptions {
  path: string;
  offset?: number;
  length?: number;
}
export type ReadResult = {
  path: string;
  size: number;
  mtime: number;
  offset: number;
  bytesRead: number;
  truncated: boolean;
} & ({ binary: true } | { binary: false; text: string; encoding: "utf-8" | "utf-8-lossy" });
export interface SearchOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  glob?: string;
  limit: number;
  byteBudget?: number;
  signal?: AbortSignal;
}
export interface Match {
  path: string;
  line: number;
  column: number;
  preview: string;
}
export interface SearchResult {
  matches: Match[];
  truncated: boolean;
  bytesScanned: number;
  backend: "ripgrep" | "node";
}
export interface Change {
  path: string;
  kind: "created" | "changed" | "deleted";
}
export interface WatchOptions {
  onChange: (changes: Change[]) => void;
  onWarning?: (message: string) => void;
}
export interface WorkspaceWatcher {
  readonly mode: "native" | "polling";
  /** Reconcile immediately and wait for the resulting batch. */
  flush(): Promise<void>;
  dispose(): Promise<void>;
}
export interface WorkspaceOptions {
  /** null forces the pure Node backend; otherwise resolved from PATH by default. */
  ripgrep?: string | null;
  watchMode?: "native" | "polling";
}
export const READ_CAP = 1024 * 1024;
export const TREE_CAP = 100_000;
export const DIRECTORY_CAP = 10_000;
export const SEARCH_BUDGET = 16 * 1024 * 1024;
