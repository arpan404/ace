import type { ClientCore } from "@ace/client";
import type { ThreadListEntry } from "@ace/protocol";
import { accountBadge, accountView, providerAccount, type AccountView } from "@ace/ui-core";
import { host } from "./host.ts";

/**
 * The machine's provider accounts, read on every ready connection, so each inbox row's provider
 * mark can wear its account bubble. A machine that refuses its accounts draws plain marks.
 * `changed` runs once a fresh list arrives.
 */
export function followAccounts(owner: ClientCore, changed: () => void) {
  let views: readonly AccountView[] = [];
  let stopped = false;
  const connection = owner.connectionState();
  const load = () => {
    if (connection.getSnapshot() !== "ready") return;
    owner
      .request({ type: "accounts.list", requestId: host.uuid() }, { timeoutMs: 15_000 })
      .then((listed) => {
        if (stopped) return;
        views = listed.accounts.map(accountView);
        changed();
      })
      .catch(() => {});
  };
  const unsubscribe = connection.subscribe(load);
  load();
  return {
    views: () => views,
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}

/**
 * The account bubble a row's provider mark wears (the shared two-letter badge), or null when the
 * provider has one account or runs on the CLI's plain login (`providerAccount`).
 */
export function rowAccount(
  views: readonly AccountView[],
  entry: Pick<ThreadListEntry, "provider" | "execution" | "live">,
): string | null {
  const { account, bubble } = providerAccount(views, {
    provider: entry.provider,
    instance: entry.execution?.instanceId ?? entry.live?.account,
  });
  return bubble && account ? accountBadge(account.label, account.shortLabel) : null;
}
