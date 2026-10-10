import { ClientError } from "@ace/client";
import type { ErrorShape } from "./wire.ts";

/**
 * A value that crossed the worker port from this package's other end. It came from the
 * worker's client, which decoded it with @ace/protocol schemas; a structured clone of that data
 * is not decoded again (ADR 0056). Use only for such payloads.
 */
export function trusted<T>(value: unknown): T {
  return value as T;
}

const codes = new Set<string>([
  "stale",
  "offline",
  "timeout",
  "aborted",
  "limit",
  "busy",
  "protocol",
  "auth",
  "storage",
  "daemon",
]);
const isCode = (code: string): code is ClientError["code"] => codes.has(code);

/** A ClientError rebuilt from its shape; unknown codes read as protocol errors. */
export function toError(shape: ErrorShape): ClientError {
  return new ClientError(isCode(shape.code) ? shape.code : "protocol", shape.message);
}
