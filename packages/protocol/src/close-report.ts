import { z } from "zod";

/**
 * Why a client's connection ended, from a fixed list: never free text, so a report can't carry
 * anything but this (#1876). `emsgsize` is a message the client's socket refused as too large;
 * `receive_failed` and `send_failed` the socket's other failures; `handshake_timeout` a relay
 * channel that never secured; `heartbeat` a ping that went unanswered; `peer_closed` the far end
 * or relay ending it; `other` anything else, or a cause this daemon doesn't know.
 */
export const ClientCloseCause = z.enum([
  "emsgsize",
  "receive_failed",
  "send_failed",
  "handshake_timeout",
  "heartbeat",
  "peer_closed",
  "other",
]);
export type ClientCloseCause = z.infer<typeof ClientCloseCause>;

/**
 * What a client knows of how its last connection ended, sent in its next hello so the daemon's
 * log says why a remote drop happened (#1876): the relay only tells the daemon that the far end
 * went away. Numbers and a listed cause only.
 */
export const ClientCloseReport = z.object({
  code: z.number().int().min(0).max(4999),
  cause: ClientCloseCause.catch("other").meta({
    "x-ace-json-input": ClientCloseCause,
    "x-ace-constraint": "A cause this daemon doesn't know is read as `other`.",
  }),
  /** The connection had been welcomed before it ended. */
  wasReady: z.boolean(),
  /** How long it had been ready, when it was. */
  aliveMs: z.number().int().nonnegative().optional(),
  /** From the end to this hello. */
  downMs: z.number().int().nonnegative().optional(),
  /** Reconnect attempts since the last healthy connection. */
  attempt: z.number().int().nonnegative(),
});
export type ClientCloseReport = z.infer<typeof ClientCloseReport>;
