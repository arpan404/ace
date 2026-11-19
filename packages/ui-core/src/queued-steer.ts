import type { QueuedMessage } from "@ace/protocol";

/*
 * What a waiting message's row says about its steering, the same on every client. Pure.
 */

export interface QueuedSteer {
  /** The words beside the message, when its steering has something to say. */
  note?: string;
  /** Whether the row offers Steer: only a message that would otherwise wait for the turn's end. */
  canSteer: boolean;
}

/**
 * A steer waiting while the root turn runs goes in at the next step; between turns it is simply
 * the next message. One the provider refused fell back and waits for the turn's end.
 */
export function queuedSteer(
  message: Pick<QueuedMessage, "delivery" | "fellBack">,
  turnRunning: boolean,
): QueuedSteer {
  if (message.fellBack)
    return {
      note: turnRunning ? "Couldn't steer · sends after this turn" : "Couldn't steer · sends next",
      canSteer: true,
    };
  if (message.delivery === "queue") return { canSteer: true };
  return {
    note: turnRunning ? "Steering at the next step" : "Sends as the next message",
    canSteer: false,
  };
}
