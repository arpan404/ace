import { usePendingSends } from "@ace/client-react";
import { useLayoutEffect, useMemo } from "react";
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
 * transcript's view of them. Renders nothing. Published before paint, so a message sent shows
 * as its bubble in the same frame.
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
  return null;
}
