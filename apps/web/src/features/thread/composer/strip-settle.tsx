import { usePendingSends } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import { useEffect, useState, type ReactNode } from "react";

/** The longest the strip holds still for a send, so a slow one still shows its own strip. */
const settleLimitMs = 2_000;

/**
 * Whether a message just sent from here is still settling: its send is on the wire, or the
 * daemon took it and the turn hasn't started yet. Each of those steps would change what the
 * strip shows (the held notice, the message on its way, the queue, nothing), and each change of
 * height moves the transcript, so the strip holds still until the turn runs and has taken the
 * message, for at most two seconds. A message sent while a turn already runs isn't held: it
 * waits in the queue, and the queue says so at once.
 */
export function useSendSettling(
  threadId: string,
  status: ThreadStatus | undefined,
  /** Messages in the strip's queue: the turn takes the sent one from there. */
  queued: number,
): boolean {
  // Saving to the outbox or sent without a receipt: quick sends never show their own strip,
  // so this reads the outbox itself.
  const inFlight = usePendingSends(threadId).some(
    (send) => send.state === "saving" || send.state === "sent",
  );
  // A turn that moved on (working, asking, limited, failed) ends the wait; a message waiting in
  // the queue hasn't moved it yet.
  const moved =
    status !== undefined &&
    status.state !== "done" &&
    status.state !== "new" &&
    !(status.state === "waiting" && status.on === "queue");
  const [wasInFlight, setWasInFlight] = useState(inFlight);
  const [awaitingTurn, setAwaitingTurn] = useState(false);
  const [expired, setExpired] = useState(false);
  if (wasInFlight !== inFlight) {
    setWasInFlight(inFlight);
    if (inFlight) setExpired(false);
    else setAwaitingTurn(!moved);
  }
  // Settled once the turn runs and has taken the message from the queue.
  if (awaitingTurn && moved && queued === 0) setAwaitingTurn(false);
  const settling = (inFlight || awaitingTurn) && !expired;
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => {
      setExpired(true);
      setAwaitingTurn(false);
    }, settleLimitMs);
    return () => clearTimeout(timer);
  }, [settling]);
  return settling;
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
