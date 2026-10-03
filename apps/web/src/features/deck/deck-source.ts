/*
 * The one boundary between the Deck screens and the daemon: the conductor runs of this client's
 * daemon (`deck-store.ts`) as Deck view models, with lane accounts named from `accounts.list`.
 */
import { deckFromSummary, deckFromView, type DeckAccounts, type DeckRun } from "@ace/ui-core";
import { useEffect } from "react";
import { useAccountViews } from "@/features/accounts/index.ts";
import { useDeckSnapshot, useDeckStore } from "./use-deck-store.ts";

export { useDeckSender } from "./use-deck-store.ts";

function useAccountNames(): DeckAccounts {
  const accounts = useAccountViews().data;
  const byId = new Map(accounts?.map((account) => [account.id, account]));
  return (id) => {
    const account = byId.get(id);
    return (
      account && {
        label: `${account.providerLabel} · ${account.label}`,
        provider: account.provider,
      }
    );
  };
}

export function useDeckRuns(): { ready: boolean; error: string | undefined; runs: DeckRun[] } {
  const snapshot = useDeckSnapshot();
  const accounts = useAccountNames();
  const runs = snapshot.entries.map((entry) =>
    entry.view ? deckFromView(entry.view, accounts) : deckFromSummary(entry.summary),
  );
  return { ready: snapshot.ready, error: snapshot.error, runs };
}

export function useDeckRun(id: string): { ready: boolean; run: DeckRun | undefined } {
  const store = useDeckStore();
  const { ready, runs } = useDeckRuns();
  useEffect(() => {
    if (ready) store.ensure(id);
  }, [store, id, ready]);
  return { ready, run: runs.find((run) => run.id === id) };
}
