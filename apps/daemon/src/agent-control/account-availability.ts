import {
  accountProvider,
  blockedUntil,
  refusalWords,
  type AccountRefusal,
  type Candidate,
} from "@ace/accounts";

/**
 * A known exhausted account names alternatives; unknown usage never blocks a launch. Only the
 * usage limit is judged here: sign-in (with its no-auth model exemption), disabled accounts and
 * unusable homes stay with the callers that already own those checks.
 */
export function accountLaunchRefusal(
  candidates: readonly Candidate[],
  id: string,
  now: number,
  enabled: (id: string) => boolean = () => true,
  /** How the refused account is named, as the caller words refusals for the person. */
  words: (selected: Candidate, refusal: AccountRefusal) => string = (selected, refusal) =>
    refusalWords(`Account ${selected.instance.label || id} (${id})`, refusal, now, "UTC"),
): string | undefined {
  const selected = candidates.find((entry) => entry.instance.id === id);
  if (!selected) return undefined;
  const until = blockedUntil(selected.quota, now);
  if (until === undefined) return undefined;
  const provider = accountProvider(selected.instance);
  const reason = words(selected, { reason: "at_limit", until });
  const alternatives = candidates.filter(
    ({ instance, quota }) =>
      instance.id !== id &&
      accountProvider(instance) === provider &&
      enabled(instance.id) &&
      !quota.blockers.homeUnavailable &&
      quota.auth !== "logged_out" &&
      blockedUntil(quota, now) === undefined,
  );
  const list = alternatives
    .map(({ instance }) => `${instance.label || instance.id} (${instance.id})`)
    .join(", ");
  return `${reason}.${list ? ` Other accounts with usage or unread limits: ${list}.` : " No other eligible account is known on this machine."}`.slice(
    0,
    512,
  );
}
