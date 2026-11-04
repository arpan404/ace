import type { FailureAccount } from "./failure-account.ts";
import type { AgentStatus, DelegationFailure, Thread } from "@ace/protocol";

/** Only canonical provider evidence counts; assistant prose never classifies a limit. */
export function failureResult(
  thread: Pick<Thread, "status" | "queue">,
  status: AgentStatus | undefined,
  account: FailureAccount = {},
): DelegationFailure | undefined {
  const error = status?.state === "failed" ? status.error : undefined;
  const code = error?.code ?? error?.details?.code ?? error?.kind;
  const limited =
    thread.status.state === "limited" ||
    (thread.status.state === "failed" && account.usageLimited === true) ||
    [
      "usage_limit",
      "usage_limited",
      "usageLimitExceeded",
      "quota",
      "rate_limit",
      "model_quota",
    ].includes(code ?? "");
  if (!limited && thread.status.state !== "failed") return undefined;
  const resetsAt =
    (thread.status.state === "limited" ? thread.status.until : undefined) ?? account.resetsAt;
  const who = account.accountLabel ?? account.accountId;
  const message = limited
    ? `Usage limit reached${who ? ` on account ${who}` : ""}${resetsAt !== undefined ? ` until ${new Date(resetsAt).toISOString()}` : ""}. ${error?.message ?? (status?.state === "blocked" ? status.message : undefined) ?? "The provider stopped this turn."}`
    : (error?.message ??
      thread.queue?.lastFailure?.title ??
      "The provider stopped without returning a result.");
  return {
    code: limited ? "usage_limited" : "provider_failed",
    message: message.slice(0, 512),
    ...(account.accountId ? { accountId: account.accountId } : {}),
    ...(account.accountLabel ? { accountLabel: account.accountLabel } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}
