import type { AccountView, PickerModel, PickerProvider } from "@ace/ui-core";
import { accountLimit, isPlainCliLogin, providerNames } from "@ace/ui-core";
import { acpAgentName } from "@ace/ui-core/provider-icons";
import type { ProviderKind } from "@ace/protocol";

export interface PickerEntry {
  id: string;
  provider?: ProviderKind | undefined;
  instance?: string | undefined;
  /** The ACP agent an account belongs to: each agent keeps its own rail tab and logo. */
  acpAgentId?: string | undefined;
  name: string;
  reason?: string | undefined;
}

/**
 * The rail's tabs: Favorites, then one per account that is set up, each provider's default first.
 * A CLI that isn't installed or configured, and an account signed out with nothing listed, have
 * no tab at all; an account at its limit keeps its tab, dimmed, and says when it resets. The
 * account `keep` names (the one the thread runs on) always keeps its tab.
 */
export function pickerEntries(
  providers: readonly PickerProvider[],
  models: readonly PickerModel[],
  accounts: readonly AccountView[],
  now: number,
  limitText: (at: number | undefined) => string,
  keep?: { provider: ProviderKind | undefined; instance: string | undefined },
): PickerEntry[] {
  const kept = (provider: ProviderKind, instance?: string) =>
    keep?.provider === provider && (instance === undefined || keep.instance === instance);
  return [
    { id: "favorites", name: "Favorites" },
    ...providers.flatMap((entry): PickerEntry[] => {
      const own = accounts
        .filter((account) => account.provider === entry.provider)
        .toSorted((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
      const listed = new Set(
        models
          .filter((model) => model.provider === entry.provider)
          .map((model) => model.instance)
          .filter((id) => id !== undefined),
      );
      const instances = [
        ...own.map((account) => account.id),
        ...[...listed].filter((id) => !own.some((candidate) => candidate.id === id)),
      ];
      if (!instances.length)
        return entry.reason && !kept(entry.provider)
          ? []
          : [
              {
                id: entry.provider,
                provider: entry.provider,
                name: providerNames[entry.provider],
                reason: entry.reason,
              },
            ];
      return instances.flatMap((instance): PickerEntry[] => {
        const account = own.find((candidate) => candidate.id === instance);
        const limit = account && accountLimit(account, now);
        const label =
          account?.label ??
          models.find((model) => model.instance === instance)?.source?.label ??
          "Account";
        // An ACP agent goes by its own name ("Gemini CLI"), with the account only when the same
        // agent is signed in more than once.
        const agent =
          entry.provider === "acp" && account?.acpAgentId
            ? acpAgentName(account.acpAgentId)
            : undefined;
        const twins = own.filter((candidate) => candidate.acpAgentId === account?.acpAgentId);
        // The CLI's own login, never renamed, is the provider itself: "Codex", no bubble.
        const plain = account !== undefined && isPlainCliLogin(account);
        const name = agent
          ? twins.length > 1 && !plain
            ? `${agent} · ${label}`
            : agent
          : !plain && (account || instances.length > 1)
            ? `${providerNames[entry.provider]} · ${label}`
            : providerNames[entry.provider];
        const signedOut =
          account?.availability === "logged_out" &&
          !models.some((model) => model.instance === instance);
        // Not set up: no tab, unless the thread runs on it.
        if (
          (signedOut || (entry.reason && limit?.level !== "reached")) &&
          !kept(entry.provider, instance)
        )
          return [];
        return [
          {
            id: `${entry.provider}:${instance}`,
            provider: entry.provider,
            instance,
            acpAgentId: account?.acpAgentId,
            name,
            reason:
              limit?.level === "reached"
                ? limitText(limit.resetsAt)
                : signedOut
                  ? `Sign in to ${name}`
                  : entry.reason,
          },
        ];
      });
    }),
  ];
}
