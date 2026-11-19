/** The relay itself closed the socket, with the code it gave. */
export class RelayClosedError extends Error {
  readonly code: number;
  constructor(code: number, reason: string) {
    super(reason || "Relay channel closed");
    this.name = "RelayClosedError";
    this.code = code;
  }
}
