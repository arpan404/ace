/**
 * The relay refused this peer (close 1008 or 4001, or an HTTP 401/403 upgrade answer): ace's
 * hosted relay without a valid grant, or a host id the relay does not admit. Retrying the same
 * credentials cannot succeed, so callers stop and say why instead of reconnecting.
 */
export class RelayRefusedError extends Error {
  override name = "RelayRefusedError";
  readonly code: number;
  constructor(code: number, reason: string) {
    super(reason || "The relay refused this connection");
    this.code = code;
  }
}

export const refusalCloseCodes: ReadonlySet<number> = new Set([1008, 4001]);

/** The refusal an upgrade error stands for, when ws reports the relay's HTTP answer. */
export function upgradeRefusal(error: unknown): RelayRefusedError | undefined {
  const status = /Unexpected server response: (\d{3})/.exec(
    error instanceof Error ? error.message : "",
  )?.[1];
  return status === "401" || status === "403"
    ? new RelayRefusedError(Number(status), "The relay refused this connection")
    : undefined;
}
