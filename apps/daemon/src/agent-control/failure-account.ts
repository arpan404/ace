import { blockedUntil, type AccountRegistry } from "@ace/accounts";
import type { ProviderKind } from "@ace/protocol";

export interface FailureAccount {
  accountId?: string;
  accountLabel?: string;
  usageLimited?: boolean;
  resetsAt?: number;
}

/** The actual selected account, with fresh limit evidence only. No provider calls. */
export function failureAccount(
  provider: ProviderKind,
  instanceId: string | undefined,
  accounts: AccountRegistry | undefined,
  now: number,
): FailureAccount {
  const accountId = instanceId ?? (provider === "acp" ? undefined : `${provider}-cli-default`);
  const account = accountId ? accounts?.get(accountId) : undefined;
  const until = account ? blockedUntil(account.quota, now) : undefined;
  return {
    ...(accountId ? { accountId } : {}),
    ...(account?.instance.label ? { accountLabel: account.instance.label } : {}),
    ...(until !== undefined ? { usageLimited: true } : {}),
    ...(typeof until === "number" ? { resetsAt: until } : {}),
  };
}
