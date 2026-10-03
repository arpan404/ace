/*
 * The one boundary between the Deck screens and the daemon: the conductor runs of this client's
 * daemon (`deck-store.ts`) as Deck view models, with lane accounts named from `accounts.list`.
 */
import { deckFromSummary, deckFromView, type DeckAccounts, type DeckRun } from "@ace/ui-core";
import { useEffect } from "react";
import { useAccountViews } from "@/features/accounts/index.ts";
import { useDeckSnapshot, useDeckStore } from "./use-deck-store.ts";

export { useDeckSender } from "./use-deck-store.ts";

/** Lane accounts named from `accounts.list`; not settled until that read lands or fails. */
function useAccountNames(): { settled: boolean; accounts: DeckAccounts } {
  const query = useAccountViews();
  const byId = new Map(query.data?.map((account) => [account.id, account]));
  const accounts: DeckAccounts = (id) => {
    const account = byId.get(id);
    return (
      account && {
        label: `${account.providerLabel} · ${account.label}`,
        provider: account.provider,
      }
    );
  };
  return { settled: !query.isPending, accounts };
}

export function useDeckRuns(): { ready: boolean; error: string | undefined; runs: DeckRun[] } {
  const snapshot = useDeckSnapshot();
  const { settled, accounts } = useAccountNames();
  const runs = snapshot.entries.map((entry) =>
    entry.view ? deckFromView(entry.view, accounts) : deckFromSummary(entry.summary),
  );
  // Wait for the account names too, so a lane never flashes "Account removed" while they load.
  return { ready: snapshot.ready && settled, error: snapshot.error, runs };
}

export function useDeckRun(id: string): { ready: boolean; run: DeckRun | undefined } {
  const store = useDeckStore();
  const { ready, runs } = useDeckRuns();
  useEffect(() => {
    if (ready) store.ensure(id);
  }, [store, id, ready]);
  return { ready, run: runs.find((run) => run.id === id) };
}
