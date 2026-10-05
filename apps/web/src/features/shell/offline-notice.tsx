import { usePendingSends } from "@ace/client-react";
import type { PendingSend } from "@ace/client";
import { provisionalTitle, untitledThread } from "@ace/ui-core";
import { useId, useMemo, useState } from "react";
import { usePendingActions } from "@/lib/pending-actions.ts";

interface Waiting {
  key: string;
  label: string;
}

/** "Message · Fix the login redirect", or just "Message" for one without words. */
function sendLabel(send: PendingSend): string {
  const kind = send.payload.type === "thread.create" ? "New thread" : "Message";
  const words = provisionalTitle(send.payload.input);
  return words === untitledThread ? kind : `${kind} · ${words}`;
}

/**
 * What is saved on this device and goes to the daemon when it is back: messages and new threads
 * from every window (the client's pending sends), and this window's organize actions. Answers,
 * Stop and other commands also wait in the outbox, but the client doesn't list them.
 */
function useWaiting(): readonly Waiting[] {
  const sends = usePendingSends();
  const actions = usePendingActions();
  return useMemo(
    () => [
      ...sends
        .filter((send) => send.state === "saving" || send.state === "sent")
        .map((send) => ({ key: send.commandId, label: sendLabel(send) })),
      ...actions
        .filter((action) => action.waiting)
        .map((action) => ({ key: `organize:${action.key}`, label: action.label })),
    ],
    [sends, actions],
  );
}

/** Offline: what still works, how much waits, and (opened) what exactly waits. */
export function OfflineNotice(props: { words: string }) {
  const waiting = useWaiting();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const words = props.words;
  return (
    <div className="fx-view-in shrink-0 border-b text-sm text-muted-foreground">
      <div role="status" className="flex h-8 items-center justify-center gap-2">
        {waiting.length ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen(!open)}
            className="rounded-sm px-1 outline-none hover:text-foreground focus-visible:shadow-[0_0_0_2px_var(--ring)]"
          >
            {words} · {waiting.length} waiting
          </button>
        ) : (
          words
        )}
      </div>
      {open && waiting.length > 0 && (
        <ul
          id={listId}
          aria-label="Waiting for the daemon"
          className="mx-auto max-h-40 max-w-[560px] overflow-y-auto px-4 pb-2"
        >
          {waiting.map((item) => (
            <li key={item.key} className="truncate py-0.5">
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
