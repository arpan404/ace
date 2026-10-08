import { useThreadMeta } from "@ace/client-react";
import type { Thread } from "@ace/protocol";
import { accountLimit } from "@ace/ui-core";
import { useNow } from "@/lib/time.ts";
import type { AccountView } from "@ace/ui-core";
import { useAccountViews } from "@/features/accounts/index.ts";

/** How often meters on screen read quota again: the daemon doesn't push quota changes. */
export const quotaRefreshMs = 60_000;

/**
 * The account a thread's next turn uses: an account switch waiting for it, else the one it runs
 * on now, else the one its execution names. Undefined while the daemon picks.
 */
export function threadAccountId(meta: Thread | undefined): string | undefined {
  if (!meta) return undefined;
  const queued = meta.switch?.state === "queued" ? meta.switch.selection.instanceId : undefined;
  return queued ?? meta.live?.account ?? meta.execution?.instanceId;
}

/**
 * The thread's account from `accounts.list`, with every account (for where to move it), read
 * again every `quotaRefreshMs` while shown. Nothing is read until the thread names an account.
 */
export function useThreadAccount(
  threadId: string,
  enabled = true,
): {
  account: AccountView | undefined;
  accounts: readonly AccountView[] | undefined;
} {
  const id = threadAccountId(useThreadMeta(threadId));
  const accounts = useAccountViews({
    enabled: enabled && id !== undefined,
    refreshMs: quotaRefreshMs,
  });
  const account = id === undefined ? undefined : accounts.data?.find((entry) => entry.id === id);
  return { account, accounts: accounts.data };
}

/** Every usage-pause surface reads the same thread reset, with its account as fallback. */
export function useThreadReset(threadId: string): number | undefined {
  const status = useThreadMeta(threadId)?.status;
  const { account } = useThreadAccount(threadId, status?.state === "limited");
  const now = useNow();
  return (
    (status?.state === "limited" ? status.until : undefined) ??
    (account ? accountLimit(account, now).resetsAt : undefined)
  );
}
