import { useConnectionState, usePendingSends } from "@ace/client-react";
import { formatClock } from "@ace/ui-core";
import { useLayoutEffect, useMemo, useState } from "react";
import { useSeconds } from "@/lib/time.ts";
import { leasable, publishLocalSends } from "../composer/send-store.ts";
import {
  commandOf,
  inputItemId,
  useDeliveryFailures,
  useDismissedSends,
  useQueuedCommands,
  useStaged,
  withLocalSends,
} from "./pending-sends.ts";

/**
 * Works out this window's messages on their way for one thread (outbox entries, messages held
 * for their uploads, the ones dismissed, still queued, or not delivered) and publishes the
 * transcript's view of them, before paint, so a message sent shows as its bubble in the same
 * frame. At the live end it says since when this window has been offline (SY-6).
 */
export function LocalSends(props: { threadId: string }) {
  const { threadId } = props;
  const pending = usePendingSends(threadId);
  const staged = useStaged(threadId);
  const dismissed = useDismissedSends();
  const queued = useQueuedCommands(threadId);
  const failures = useDeliveryFailures(leasable(threadId));
  const view = useMemo(() => {
    const local = { pending, staged, dismissed, queued, failures };
    return {
      merge: (
        blocks: Parameters<typeof withLocalSends>[0],
        itemsOf: Parameters<typeof withLocalSends>[2],
      ) => withLocalSends(blocks, local, itemsOf),
      find: (itemId: string) => {
        const send = pending.find((entry) => entry.itemId === itemId);
        const commandId = send?.commandId ?? commandOf(itemId);
        return {
          send,
          staged: staged.find((entry) => inputItemId(entry.commandId) === itemId),
          noticeId: commandId === undefined ? undefined : failures.get(commandId),
        };
      },
    };
  }, [pending, staged, dismissed, queued, failures]);
  useLayoutEffect(() => publishLocalSends(threadId, view), [threadId, view]);
  useLayoutEffect(() => () => publishLocalSends(threadId, undefined), [threadId]);
  return <OfflineSince />;
}

/** "Offline since 5:31 PM", at the transcript's live end while the daemon can't be reached. */
function OfflineSince() {
  const state = useConnectionState();
  const away = state === "offline" || state === "reconnecting";
  const now = useSeconds(false);
  const [since, setSince] = useState<number>();
  if (away && since === undefined) setSince(now);
  if (!away && since !== undefined) setSince(undefined);
  if (!away || since === undefined) return null;
  return (
    <p role="status" className="pt-2 text-xs text-subtle-foreground">
      Offline since {formatClock(since)}
    </p>
  );
}
