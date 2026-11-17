import type { DelegationRequest } from "@ace/protocol";
import type { AccountRegistry } from "@ace/accounts";
import { AgentControlError } from "./failure.ts";
import type { ModelLoadBudget } from "./model-load-budget.ts";

/*
 * A delegation is placed on an account only once the home folders it could go to have answered
 * startup's check (ADR 0175): the named account's, or every candidate's when ace picks by limits.
 * An account still checking is never passed over for another one.
 */

/** The accounts whose checks decide where this request goes. */
export function delegationCandidates(
  accounts: AccountRegistry,
  request: Pick<DelegationRequest, "provider" | "instanceId">,
  accountId: string | undefined,
): string[] {
  if (request.provider === "acp") return request.instanceId ? [request.instanceId] : [];
  if (accountId) return [accountId];
  return accounts.checkingIds(request.provider);
}

/** Refuses, saying why, while any of `ids` hasn't answered its check. */
export function assertChecked(accounts: AccountRegistry, ids: readonly string[]): void {
  const waiting = ids.filter((id) => accounts.isChecking(id));
  if (!waiting.length) return;
  const names = waiting.map((id) => `"${accounts.get(id)?.instance.label ?? id}"`).join(", ");
  const reason =
    `The folder of the account ${names} hasn't answered yet, so ace didn't place this work on it or on another account; try again shortly`.slice(
      0,
      256,
    );
  throw new AgentControlError("account_unavailable", reason, undefined, reason);
}

/** Waits, within the operation's budget and cancellation, for those checks; refuses if they don't answer. */
export async function awaitDelegationAccounts(
  accounts: AccountRegistry | undefined,
  request: Pick<DelegationRequest, "provider" | "instanceId">,
  accountId: string | undefined,
  budget: ModelLoadBudget,
): Promise<void> {
  if (!accounts) return;
  const ids = delegationCandidates(accounts, request, accountId).filter((id) =>
    accounts.isChecking(id),
  );
  if (ids.length) await budget.wait(Promise.all(ids.map((id) => accounts.checked(id))));
  assertChecked(accounts, delegationCandidates(accounts, request, accountId));
}
