import { z } from "zod";

/**
 * How an agent's message reaches the thread it was sent to, read once ace accepted it:
 * `starting` begins its next turn now; `steering` joins the running turn (after a running tool
 * returns); `restarting` interrupts the running turn and restarts it with the message (Cursor's
 * steer); `queued` runs when that turn ends; `held` waits for a hold to lift (a limit, a retry, a
 * request to the person, a paused queue, or a send that may already have run); `delivered` is a
 * retry of a message the provider already took.
 */
export const MessageArrival = z.enum([
  "starting",
  "steering",
  "restarting",
  "queued",
  "held",
  "delivered",
]);
export type MessageArrival = z.infer<typeof MessageArrival>;
