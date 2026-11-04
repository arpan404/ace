import type { FailureAccount } from "./failure-account.ts";
import type { AgentStatus, DelegationFailure, Thread } from "@ace/protocol";

/** Provider codes for an allowance that is used up until a reset. */
const usageCodes = new Set([
  "usage_limit",
  "usage_limited",
  "usageLimitExceeded",
  "quota",
  "model_quota",
]);
/** Provider codes for short-lived throttling: the account itself still has usage left. */
const rateCodes = new Set([
  "rate_limit",
  "rate_limited",
  "rate_limit_exceeded",
  "rateLimitExceeded",
]);

/** Only canonical provider evidence counts; assistant prose never classifies a limit. */
export function failureResult(
  thread: Pick<Thread, "status" | "queue">,
  status: AgentStatus | undefined,
  account: FailureAccount = {},
): DelegationFailure | undefined {
  const error = status?.state === "failed" ? status.error : undefined;
  const codes = [error?.code, error?.details?.code, error?.kind].filter(
    (code): code is string => typeof code === "string",
  );
  // A thread reads limited only once its turn ended on a quota error (see core's endTurn).
  const usage =
    thread.status.state === "limited" ||
    (thread.status.state === "failed" && account.usageLimited === true) ||
    codes.some((code) => usageCodes.has(code));
  const rate = !usage && codes.some((code) => rateCodes.has(code));
  if (!usage && !rate && thread.status.state !== "failed") return undefined;
  const resetsAt = usage
    ? ((thread.status.state === "limited" ? thread.status.until : undefined) ?? account.resetsAt)
    : undefined;
  const who = account.accountLabel ?? account.accountId;
  const on = who ? ` on account ${who}` : "";
  const detail =
    error?.message ?? (status?.state === "blocked" ? status.message : undefined) ?? undefined;
  const message = usage
    ? `Usage limit reached${on}${resetsAt !== undefined ? ` until ${new Date(resetsAt).toISOString()}` : ""}. ${detail ?? "The provider stopped this turn."}`
    : rate
      ? `Rate limited by the provider${on}; this is temporary and the account still has usage. ${detail ?? "The provider stopped this turn."}`
      : (detail ??
        thread.queue?.lastFailure?.title ??
        "The provider stopped without returning a result.");
  return {
    code: usage ? "usage_limited" : rate ? "rate_limited" : "provider_failed",
    message: message.slice(0, 512),
    ...(account.accountId ? { accountId: account.accountId } : {}),
    ...(account.accountLabel ? { accountLabel: account.accountLabel } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}
