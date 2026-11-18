import type { Reply } from "./schemas.ts";

/** The codes a failed file request carries. The binary's own codes arrive unchanged. */
export type FilesErrorCode = string;

/** A request that ace-files, or its supervisor, refused or gave up on. */
export class FilesRequestError extends Error {
  readonly code: FilesErrorCode;
  /** The file's version now, on a rejected write, so the editor can offer to reload. */
  readonly current: string | undefined;

  constructor(code: FilesErrorCode, message: string, current?: string) {
    super(message);
    this.name = "FilesRequestError";
    this.code = code;
    this.current = current;
  }

  /** True when the same request can be sent again: restarting, or stdin is saturated. */
  get retryable(): boolean {
    return this.code === "FILES_RESTARTING" || this.code === "BUSY";
  }
}

/** Where ace-files is in its supervision cycle. */
export type FilesState = "idle" | "starting" | "up" | "down" | "disposed";

/** One log line from the supervisor; the daemon supplies the sink. */
export type FilesLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  fields?: Record<string, unknown>,
) => void;

/** What one request may carry besides its op. */
export type FilesRequestOptions = {
  /** Aborting sends `cancel` and fails the request with `CANCELLED`. */
  signal?: AbortSignal | undefined;
  /** Overrides the process's default 30 s. */
  timeoutMs?: number | undefined;
  /** Bytes for `write` and `createFile`, sent in a kind-2 frame after the request. */
  body?: Uint8Array | undefined;
};

/** A response and the body frame that belongs to it, when it had one. */
export type FilesResult = {
  reply: Reply;
  body: Uint8Array;
};
