/*
 * The one boundary between the Deck screens and the daemon: the conductor runs of this client's
 * daemon (`deck-store.ts`) as Deck view models, with accounts named from `accounts.list` and
 * agent times from the live thread list.
 */
import type { SidebarReader } from "@ace/client";
import { useSidebar, type SidebarKey } from "@ace/client-react";
import {
  deckFromSummary,
  deckFromView,
  type DeckAccounts,
  type DeckRun,
  type DeckThread,
  type DeckThreads,
} from "@ace/ui-core";
import { useEffect } from "react";
import { useAccountViews } from "@/features/accounts/index.ts";
import { useDeckSnapshot, useDeckStore } from "./use-deck-store.ts";

export { useDeckMore, useDeckRetry, useDeckSender } from "./use-deck-store.ts";

/** Accounts named from `accounts.list`; not settled until that read lands or fails. */
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

export function useDeckRuns(): {
  ready: boolean;
  error: string | undefined;
  runs: DeckRun[];
  /** The daemon has older decks than the list holds (`useDeckMore`). */
  more: boolean;
} {
  const snapshot = useDeckSnapshot();
  const { settled, accounts } = useAccountNames();
  const runs = snapshot.entries.map((entry) =>
    entry.view ? deckFromView(entry.view, accounts) : deckFromSummary(entry.summary),
  );
  // Wait for the account names too, so a lane never flashes "Account removed" while they load.
  return { ready: snapshot.ready && settled, error: snapshot.error, runs, more: snapshot.more };
}

type Threads = ReadonlyMap<string, DeckThread>;
const noThreads: Threads = new Map();
const sameThreads = (a: Threads, b: Threads) =>
  a.size === b.size &&
  [...a].every(([id, thread]) => {
    const other = b.get(id);
    return (
      other?.title === thread.title &&
      other.createdAt === thread.createdAt &&
      other.updatedAt === thread.updatedAt
    );
  });

/** Title and times of a deck's delegated threads, live from the thread list. */
function useDelegatedThreads(ids: readonly string[]): DeckThreads {
  const keys = ids.map((id): SidebarKey => `thread:${id}`);
  const read = (reader: SidebarReader): Threads =>
    new Map(
      ids.flatMap((id) => {
        const thread = reader.thread(id);
        return thread
          ? [
              [
                id,
                { title: thread.title, createdAt: thread.createdAt, updatedAt: thread.updatedAt },
              ],
            ]
          : [];
      }),
    );
  const threads = useSidebar(keys, read, sameThreads) ?? noThreads;
  return (id) => threads.get(id);
}

const noIds: readonly string[] = [];

export function useDeckRun(id: string): { ready: boolean; run: DeckRun | undefined } {
  const store = useDeckStore();
  const snapshot = useDeckSnapshot();
  const { settled, accounts } = useAccountNames();
  const entry = snapshot.entries.find((candidate) => candidate.summary.id === id);
  const ids = entry?.view?.delegations.map((delegation) => delegation.threadId) ?? noIds;
  const threads = useDelegatedThreads(ids);
  const listed = snapshot.ready && settled;
  // A deck the list didn't hold is still loading until its own read lands or fails.
  const ready = listed && (!!entry || snapshot.missing.has(id));
  useEffect(() => {
    if (listed) store.ensure(id);
  }, [store, id, listed]);
  const run = entry?.view
    ? deckFromView(entry.view, accounts, threads)
    : entry && deckFromSummary(entry.summary);
  return { ready, run };
}
