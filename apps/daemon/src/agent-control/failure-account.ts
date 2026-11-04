import { blockedUntil, type AccountRegistry } from "@ace/accounts";
import { cursorDefaultInstanceId } from "@ace/provider-kit/cursor-selection";
import type { ProviderKind, Thread } from "@ace/protocol";

export interface FailureAccount {
  accountId?: string;
  accountLabel?: string;
  usageLimited?: boolean;
  resetsAt?: number;
}

/** The account a provider's default CLI login is registered as; ACP agents have none. */
function defaultAccount(provider: ProviderKind): string | undefined {
  if (provider === "acp") return undefined;
  return provider === "cursor" ? cursorDefaultInstanceId : `${provider}-cli-default`;
}

/** A registered account, or none while account homes are still being validated. */
export function registered(accounts: AccountRegistry | undefined, id: string) {
  try {
    return accounts?.get(id);
  } catch {
    // Account homes are still being validated: the failure goes without the name.
    return undefined;
  }
}

/** The actual selected account, with fresh limit evidence only. No provider calls. */
export function failureAccount(
  provider: ProviderKind,
  instanceId: string | undefined,
  accounts: AccountRegistry | undefined,
  now: number,
): FailureAccount {
  const accountId = instanceId ?? defaultAccount(provider);
  const account = accountId ? registered(accounts, accountId) : undefined;
  const until = account ? blockedUntil(account.quota, now) : undefined;
  return {
    ...(accountId ? { accountId } : {}),
    ...(account?.instance.label ? { accountLabel: account.instance.label } : {}),
    ...(until !== undefined ? { usageLimited: true } : {}),
    ...(typeof until === "number" ? { resetsAt: until } : {}),
  };
}

/** The account `thread` ran on, read from its session. */
export function threadAccount(
  thread: Pick<Thread, "id" | "provider">,
  engine: { sessionMetadata(id: Thread["id"]): { instanceId?: string | undefined } } | undefined,
  accounts: AccountRegistry | undefined,
  now: number,
): FailureAccount {
  return failureAccount(
    thread.provider,
    engine?.sessionMetadata(thread.id).instanceId,
    accounts,
    now,
  );
}
