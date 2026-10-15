/** A request or connection failure the client reports to callers, by kind. */
export class ClientError extends Error {
  readonly code:
    | "stale"
    | "offline"
    | "timeout"
    | "aborted"
    | "not_dispatched"
    | "limit"
    | "busy"
    | "protocol"
    /** The daemon sent a frame this client's protocol schemas can't read: a different build. */
    | "version_mismatch"
    | "auth"
    | "storage"
    | "daemon";
  constructor(code: ClientError["code"], message: string = code) {
    super(message);
    this.name = "ClientError";
    this.code = code;
  }
}
