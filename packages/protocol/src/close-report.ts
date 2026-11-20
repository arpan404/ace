import { z } from "zod";

/**
 * What a client knows of how its last connection ended, sent in its next hello so the daemon's
 * log says why a remote drop happened (#1876): the relay only tells the daemon that the far end
 * went away. `reason` is the client's own words for it, such as the phone's relay socket's
 * `receive failed (NSPOSIXErrorDomain 40)`. Never an identity, an address or a credential.
 */
export const ClientCloseReport = z.object({
  code: z.number().int().min(0).max(4999),
  reason: z.string().max(240),
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
