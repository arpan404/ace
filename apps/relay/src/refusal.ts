/**
 * The relay refused this host for good: close 1008 after the upgrade, or HTTP 403 before it
 * (ace's hosted relay: a machine grant for another host id). A 401 (missing or expired grant)
 * or 503 is not a refusal; the host fetches a fresh grant and retries with backoff. Callers stop
 * and say why instead of reconnecting.
 */
export class RelayRefusedError extends Error {
  override name = "RelayRefusedError";
  readonly code: number;
  constructor(code: number, reason: string) {
    super(reason || "The relay refused this connection");
    this.code = code;
  }
}

/** The refusal an upgrade error stands for, when ws reports the relay's HTTP answer. */
export function upgradeRefusal(error: unknown): RelayRefusedError | undefined {
  const status = /Unexpected server response: (\d{3})/.exec(
    error instanceof Error ? error.message : "",
  )?.[1];
  return status === "403"
    ? new RelayRefusedError(403, "The relay refused this machine")
    : undefined;
}
