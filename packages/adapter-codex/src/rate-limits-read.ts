/**
 * Codex's full usage snapshot, read once a session is open. `account/rateLimits/updated`
 * notifications are sparse and never carry banked resets (`rateLimitResetCredits`) or the
 * per-limit names; this read does. It calls Codex's usage endpoint only: no model turn, no quota.
 *
 * The answer goes out as a `note` frame whose top level is the read's result, so the account
 * registry ingests it like any other rate-limit report. Servers without the method, a closed
 * session or a failed read change nothing.
 */
export function readRateLimits(options: {
  request(method: string, params: unknown): Promise<unknown>;
  emit(dir: "note", data: unknown): void;
  isClosed(): boolean;
}): void {
  options.request("account/rateLimits/read", {}).then(
    (result) => {
      if (options.isClosed() || typeof result !== "object" || result === null) return;
      if (Array.isArray(result)) return;
      options.emit("note", { ...result, event: "account-rate-limits" });
    },
    () => undefined,
  );
}
