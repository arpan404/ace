import type { ThreadDetails, ThreadStatus } from "@ace/protocol";
import { threadIsRunning } from "./live-status.ts";

/*
 * A guest session (ADR 0105): agents on another machine use this one's tools through the thread,
 * with no provider running here. Nobody here talks to them, so its bottom says whose work it is,
 * and offers Stop while they work. Pure.
 */

export interface GuestSession {
  /** The calling machine, by name, else by host. */
  machine: string;
  /** Their work runs here now: each call from there is a background row the thread waits on. */
  working: boolean;
  /** "Used by agents on Linux box. Stop to end their work." */
  line: string;
}

/** The thread's guest session, or undefined for a thread the person talks to. */
export function guestSession(
  thread:
    | { details?: Pick<ThreadDetails, "guest"> | undefined; status?: ThreadStatus | undefined }
    | undefined,
): GuestSession | undefined {
  const guest = thread?.details?.guest;
  if (!guest) return undefined;
  const machine = guest.name || guest.host;
  const working = thread.status?.state === "waiting" || threadIsRunning(thread.status);
  return {
    machine,
    working,
    line: `Used by agents on ${machine}.${working ? " Stop to end their work." : ""}`,
  };
}
