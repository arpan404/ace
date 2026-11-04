/** A request or connection failure the client reports to callers, by kind. */
export class ClientError extends Error {
  readonly code:
    | "stale"
    | "offline"
    | "timeout"
    | "aborted"
    | "not_dispatched"
    | "limit"
    /** An optional thread lease found no room, or gave its room to a thread the person opened. */
    | "no_room"
    | "busy"
    | "protocol"
    /** The daemon sent a frame this client's protocol schemas can't read: a different build. */
    | "version_mismatch"
    | "auth"
    /**
     * The daemon that answered is not the one this client expected (its saved outbox, or a
     * pinned machine, belongs to another host id). Its token may be perfectly valid.
     */
    | "identity"
    | "storage"
    /**
     * An account device needs this machine's code (ADR 0111). The message is the refusal:
     * `machine_code_required`, `machine_code_wrong` or `machine_code_locked`.
     */
    | "machine_code"
    | "daemon";
  /** With a `machine_code` refusal of `machine_code_locked`: when code entry opens again. */
  declare readonly lockedUntil?: number;
  /**
   * With `auth`: the machine's owner revoked this paired device (`DeviceRevokedClose`). Only
   * then does the client delete what it read from the machine; any other refusal keeps it.
   */
  declare readonly revoked?: true;
  constructor(code: ClientError["code"], message: string = code, lockedUntil?: number) {
    super(message);
    this.name = "ClientError";
    this.code = code;
    if (lockedUntil !== undefined) this.lockedUntil = lockedUntil;
  }
  /** The owner revoked this device: the one refusal after which what it read is deleted. */
  static revoked(message: string): ClientError {
    const error = new ClientError("auth", message);
    Object.defineProperty(error, "revoked", { value: true, enumerable: true });
    return error;
  }
}
