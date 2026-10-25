export type FolderArchiveErrorCode =
  | "TOO_LARGE"
  | "UNSAFE_ENTRY"
  | "NOT_EMPTY"
  | "CHANGED"
  | "UNREADABLE"
  | "ABORTED";

/** Typed refusal from packing or unpacking a folder archive. `path` is folder-relative. */
export class FolderArchiveError extends Error {
  readonly code: FolderArchiveErrorCode;
  readonly path: string | undefined;
  constructor(code: FolderArchiveErrorCode, message: string, path?: string) {
    super(path === undefined ? message : `${message}: ${path}`);
    this.name = "FolderArchiveError";
    this.code = code;
    this.path = path;
  }
}

export function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new FolderArchiveError("ABORTED", "Folder archive cancelled");
}
