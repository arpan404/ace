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
  | "LIMIT_EXCEEDED"
  | "ABORTED";

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
  if (process.platform === "win32" && code === "EBADF") return windowsChangedPath(error);
  const mapped =
    code === "ENOENT"
      ? "NOT_FOUND"
      : code === "ENOTDIR"
        ? "NOT_DIRECTORY"
        : code === "EACCES" || code === "EPERM"
          ? "PERMISSION_DENIED"
          : code === "ELOOP" || code === "EINVAL"
            ? "PATH_CHANGED"
            : "IO_ERROR";
  return new WorkspaceError(mapped, error instanceof Error ? error.message : String(error), error);
}
/**
 * Win32: realpath fails with EBADF when a link along the path is removed while Windows
 * resolves it, so the path changed under the request.
 */
function windowsChangedPath(error: unknown): WorkspaceError {
  return new WorkspaceError(
    "PATH_CHANGED",
    error instanceof Error ? error.message : String(error),
    error,
  );
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
export const TREE_CAP = 100_000;
export const DIRECTORY_CAP = 10_000;
