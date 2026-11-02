import type { ProviderKind } from "@ace/protocol";
import { accountDisplayName } from "./accounts.ts";
import { choiceSelection, type ModelChoice } from "./models.ts";
import { providerNames } from "./providers.ts";
import type { QueueAction } from "./queue.ts";

/*
 * Where a thread held by a usage limit can carry on: the accounts and providers with room, as
 * the limit strip's Switch lists them. One row per account (or per provider without accounts),
 * on the model closest to the one that ran out. Pure.
 */

export interface LimitDestination {
  /** The model row it switches to (`ModelChoice.id`). */
  id: string;
  provider: ProviderKind;
  /** The account, for its badge; empty for a provider without accounts. */
  accountId: string;
  /** "Codex · Personal", or "Claude" for a provider without accounts. */
  name: string;
  /** The model it carries on with: "GPT-6.1 Sol". */
  model: string;
  /** "62% left", when the provider reports usage. */
  left: string | undefined;
  /** Another provider: the conversation is handed over as context. */
  handsOver: boolean;
  /** Picking it: the held turn carries on there now. */
  action: Extract<QueueAction, { id: "switch" }>;
}

/** What the thread ran out on. */
export interface LimitSource {
  provider: ProviderKind;
  /** Its account, or empty when the provider has none. */
  accountId: string;
  /** The model's identity (`ModelChoice.key`), to carry on with the same model where it runs. */
  key: string | undefined;
}

const roomLeft = (choice: ModelChoice) =>
  choice.used === undefined ? undefined : Math.max(0, Math.round((1 - choice.used) * 100));

/** The model a destination carries on with: the same one, else the account's default. */
function bestModel(rows: readonly ModelChoice[], key: string | undefined): ModelChoice | undefined {
  const current = rows.filter((row) => !row.legacy);
  return (
    current.find((row) => row.key === key) ??
    current.find((row) => row.isDefault) ??
    current[0] ??
    rows.find((row) => row.key === key)
  );
}

/**
 * The places with room, best first: other accounts of the same provider (the session carries
 * over), then other providers (a context handoff), each by the most room left; usage a provider
 * doesn't report sorts after known room. The account that ran out, accounts at their own limit
 * and models the thread can't move to (`movable`) are left out. At most `limit` rows.
 */
export function limitDestinations(
  choices: readonly ModelChoice[],
  from: LimitSource,
  movable: (choice: ModelChoice) => boolean = () => true,
  limit = 6,
): LimitDestination[] {
  const groups = new Map<string, ModelChoice[]>();
  for (const choice of choices) {
    if (choice.exhausted || !movable(choice)) continue;
    if (choice.provider === from.provider && choice.accountId === from.accountId) continue;
    const id = `${choice.provider}\u0000${choice.accountId}`;
    groups.set(id, [...(groups.get(id) ?? []), choice]);
  }
  const rows = [...groups.values()].flatMap((group) => {
    const choice = bestModel(group, from.key);
    if (!choice) return [];
    const left = roomLeft(choice);
    const provider = providerNames[choice.provider];
    return [
      {
        destination: {
          id: choice.id,
          provider: choice.provider,
          accountId: choice.accountId,
          name: choice.account ? `${provider} · ${accountDisplayName(choice.account)}` : provider,
          model: choice.model,
          left: left === undefined ? undefined : `${left}% left`,
          handsOver: choice.provider !== from.provider,
          action: {
            id: "switch",
            label: `Continue on ${provider}`,
            selection: choiceSelection(choice),
          },
        } satisfies LimitDestination,
        left,
      },
    ];
  });
  return rows
    .toSorted(
      (a, b) =>
        Number(a.destination.handsOver) - Number(b.destination.handsOver) ||
        (b.left ?? -1) - (a.left ?? -1),
    )
    .slice(0, limit)
    .map((row) => row.destination);
}
