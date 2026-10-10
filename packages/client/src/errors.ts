/** A request or connection failure the client reports to callers, by kind. */
export class ClientError extends Error {
  readonly code:
    | "stale"
    | "offline"
    | "timeout"
    | "aborted"
    | "limit"
    | "busy"
    | "protocol"
    | "auth"
    | "storage"
    | "daemon";
  constructor(code: ClientError["code"], message: string = code) {
    super(message);
    this.name = "ClientError";
    this.code = code;
  }
}
