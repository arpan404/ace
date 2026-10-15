import type { DaemonStatus } from "../../shared/contract.ts";

/** A status that will not turn into a running daemon without the repair flow or a restart. */
export function startFailed(status: DaemonStatus): boolean {
  if (status.state === "failed" || status.state === "stopping" || status.state === "stopped")
    return true;
  // A crash restart carries the exit as its message; a slow start or a user restart does not.
  return status.state === "restarting" && status.message !== undefined;
}

/** The error a waiting client gets for a failed status. */
export function failure(status: DaemonStatus): Error {
  return new Error(status.message ?? `The daemon is ${status.state}`);
}

/** The status without the last exit's account, for a new attempt or a running daemon. */
export function fresh(status: DaemonStatus): DaemonStatus {
  const { message: _message, cause: _cause, retry: _retry, ...rest } = status;
  return rest;
}
