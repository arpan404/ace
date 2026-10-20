import type { ThreadKey, ThreadReader } from "@ace/client";
import { arrayEqual, useConnectionState, usePendingSends, useThread } from "@ace/client-react";
import { useCallback, useMemo, type ReactNode } from "react";
import { useHeld } from "@/lib/held.ts";
import { SendStatus } from "../items/send-status.tsx";
import {
  inputItemId,
  useDismissedSends,
  useQueuedCommands,
  useStaged,
} from "../items/pending-sends.ts";
import { outgoing, quietlySending, type Outgoing } from "./outgoing.ts";
import { queuedText } from "./use-queue.ts";

const sameIds = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  a === b || (!!a && !!b && arrayEqual(a, b));

/**
 * This thread's messages on their way and those that didn't go, as the strip shows them. A send
 * that goes through at once never shows: it waits `useHeld`'s moment first, so the strip
 * doesn't flash on every Enter (and the queue or a request in the slot stays put). Offline,
 * slow or failed, it shows at once.
 */
export function useOutgoing(threadId: string): readonly Outgoing[] {
  const pending = usePendingSends(threadId);
  const staged = useStaged(threadId);
  const queued = useQueuedCommands(threadId);
  const dismissed = useDismissedSends();
  const online = useConnectionState() === "ready";
  // A failed send whose message the daemon admitted: the daemon's own notice says it, there.
  const failed = useMemo(
    () => pending.flatMap((send) => (send.state === "failed" ? [send.commandId] : [])),
    [pending],
  );
  const readAdmitted = useCallback(
    (reader: ThreadReader) =>
      failed.filter((id) => reader.item(inputItemId(id))?.type === "message"),
    [failed],
  );
  const admitted = useThread(
    threadId,
    failed.map((id): ThreadKey => `item:${inputItemId(id)}`),
    readAdmitted,
    sameIds,
  );
  const rows = useMemo(
    () => outgoing({ pending, staged, queued, dismissed, admitted: new Set(admitted ?? []) }),
    [pending, staged, queued, dismissed, admitted],
  );
  const lingering = useHeld(rows.some(quietlySending));
  return useMemo(
    () => (online && !lingering ? rows.filter((row) => !quietlySending(row)) : rows),
    [rows, online, lingering],
  );
}

/**
 * Messages on their way in the composer's strip, one line each: the words, then how it goes
 * ("Sending…", "Uploading an image…", "Will apply when reconnected") or "Not sent" with its
 * reason and Retry, Edit (and Remove, for one held for its uploads).
 */
export function OutgoingStrip(props: {
  threadId: string;
  rows: readonly Outgoing[];
  indicators: ReactNode;
}) {
  return (
    <section aria-label="Messages on their way" className="w-full text-xs text-muted-foreground">
      <ul aria-label="Unsent messages">
        {props.rows.map((row, index) => {
          const text =
            row.staged?.text ||
            (row.send ? queuedText({ input: row.send.payload.input }) : "") ||
            "Attached files";
          return (
            <li
              key={row.commandId}
              data-send-id={row.commandId}
              className="flex min-h-6.5 min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 px-1 py-px"
            >
              <p className="min-w-0 flex-1 basis-32 truncate text-foreground/80" title={text}>
                {text}
              </p>
              <SendStatus threadId={props.threadId} send={row.send} staged={row.staged} />
              {index === 0 && props.indicators}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
