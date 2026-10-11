import { usePendingSends } from "@ace/client-react";
import type { PendingSend } from "@ace/client";
import { provisionalTitle, untitledThread } from "@ace/ui-core";
import { useDaemonConnection } from "@/boot/connection.tsx";
import { useMemo } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover.tsx";
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
export function OfflineNotice(_props: { words: string }) {
  const connection = useDaemonConnection();
  const waiting = useWaiting();
  const words = "Offline";
  return (
    <div className="text-xs text-muted-foreground">
      <div role="status" className="flex items-center gap-2">
        {waiting.length ? (
          <Popover>
            <PopoverTrigger className="rounded-sm px-1 outline-none hover:text-foreground focus-ring">
              {words} · {waiting.length} waiting
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 max-h-40 overflow-y-auto">
              <ul aria-label="Waiting for ace">
                {waiting.map((item) => (
                  <li key={item.key} className="truncate px-2 py-1">
                    {item.label}
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        ) : (
          words
        )}
        <button
          type="button"
          className="rounded-sm text-foreground hover:underline focus-ring"
          onClick={() => connection.retry()}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
