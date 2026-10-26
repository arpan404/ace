/**
 * Why the daemon is stopping, recorded in its "Daemon stopping" log line.
 * `signal`: SIGTERM or SIGINT (an app quit, an update or a service manager);
 * `stop-request`: an authenticated POST /v1/stop (`ace stop`);
 * `abort`: the embedding host aborted the daemon's signal;
 * `close`: a caller of the daemon API closed it;
 * `startup-failure`: startup failed and the daemon releases what it opened.
 */
export type StopSource = "signal" | "stop-request" | "abort" | "close" | "startup-failure";
export interface StopReason {
  source: StopSource;
  signal?: "SIGINT" | "SIGTERM";
}

/** An abort reason that carries its stop reason through `AbortSignal.any`. */
export class DaemonStop extends Error {
  readonly reason: StopReason;
  constructor(reason: StopReason) {
    super(`Daemon stopping (${reason.signal ?? reason.source})`);
    this.name = "DaemonStop";
    this.reason = reason;
  }
}
