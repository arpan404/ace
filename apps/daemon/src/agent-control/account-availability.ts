import { definiteRefusal, refusalWords, type Candidate } from "@ace/accounts";

/** A known blocked account names alternatives; unknown usage never blocks a launch. */
export function accountLaunchRefusal(
  candidates: readonly Candidate[],
  id: string,
  now: number,
  enabled: (id: string) => boolean = () => true,
): string | undefined {
  const selected = candidates.find((entry) => entry.instance.id === id);
  if (!selected) return undefined;
  const provider = selected.instance.provider;
  const refusal = definiteRefusal(provider, selected, now);
  if (!refusal) return undefined;
  const name = selected.instance.label || id;
  const reason = refusalWords(`Account ${name} (${id})`, refusal, now, "UTC");
  const alternatives = candidates.filter(
    (entry) =>
      entry.instance.id !== id &&
      entry.instance.provider === provider &&
      enabled(entry.instance.id) &&
      !definiteRefusal(provider, entry, now),
  );
  const list = alternatives
    .map(({ instance }) => `${instance.label || instance.id} (${instance.id})`)
    .join(", ");
  return `${reason}${list ? ` Other accounts with usage or unread limits: ${list}.` : " No other eligible account is known on this machine."}`.slice(
    0,
    512,
  );
}
