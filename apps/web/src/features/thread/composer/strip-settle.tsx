import { usePendingSends } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import { useEffect, useState, type ReactNode } from "react";

/** The longest the strip holds still for a send, so a slow one still shows its own strip. */
const settleLimitMs = 2_000;

/**
 * Whether a message sent from here while the thread was idle is still settling: its send is on
 * the wire, or the daemon took it and the turn hasn't run it yet. Each of those steps would change
 * what the strip shows (the message on its way, the queue, nothing), and each change of height
 * moves the transcript, so the strip holds still until the turn has run and taken the message
 * from the queue, for at most two seconds. A send while a turn already runs isn't held: the
 * queue says so at once. Anything that needs the person (`urgent`: a request, a lost connection,
 * a send that failed) lets go at once.
 */
export function useSendSettling(
  threadId: string,
  status: ThreadStatus | undefined,
  /** Messages in the strip's queue: the turn takes the sent one from there. */
  queued: number,
  urgent: boolean,
): boolean {
  // Saving to the outbox or sent without a receipt: quick sends never show their own strip,
  // so this reads the outbox itself.
  const inFlight = usePendingSends(threadId).some(
    (send) => send.state === "saving" || send.state === "sent",
  );
  // A turn that moved on (working, asking, limited, failed); a message waiting in the queue
  // hasn't moved it yet.
  const moved =
    status !== undefined &&
    status.state !== "done" &&
    status.state !== "new" &&
    !(status.state === "waiting" && status.on === "queue");
  const [wasInFlight, setWasInFlight] = useState(inFlight);
  const [holding, setHolding] = useState(false);
  if (wasInFlight !== inFlight) {
    setWasInFlight(inFlight);
    // Only a send from an idle thread walks the strip through its steps.
    if (inFlight && !moved && !urgent) setHolding(true);
  }
  // Settled once the receipt is in, the turn runs and it has taken the message from the queue;
  // the receipt alone isn't enough, since the message may still sit in the queue.
  if (holding && (urgent || (!inFlight && moved && queued === 0))) setHolding(false);
  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => setHolding(false), settleLimitMs);
    return () => clearTimeout(timer);
  }, [holding]);
  return holding;
}

/**
 * Shows the strip as it was when `settling` began, and keeps it there (inert, so its stale
 * controls can't act) until it ends; then the strip shows what is current, once.
 */
export function HoldWhileSettling(props: { settling: boolean; children: ReactNode }) {
  const [kept, setKept] = useState(props.children);
  if (!props.settling && kept !== props.children) setKept(props.children);
  return (
    <div inert={props.settling} className="contents">
      {props.settling ? kept : props.children}
    </div>
  );
}
