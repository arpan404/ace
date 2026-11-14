import { z } from "zod";

/**
 * What a client says about its link (ADR 0149, K3). It is the client's word, so every field is
 * optional and bounded. It only picks where a viewer's video starts: a hint can start it lower,
 * never higher, and never moves a rate the link has measured.
 *
 * - The web: `navigator.connection` (`effectiveType`, `downlink` in kbit/s, `rtt`, `saveData`)
 *   and the `Save-Data` preference.
 * - iOS: `NWPath` `isExpensive` and `isConstrained`, with the round trip the app measured.
 */
export const MediaLinkHint = z.object({
  /** `slow-2g`, `2g`, `3g` or `4g` today; an open string, so a later value still parses. */
  effectiveType: z.string().min(1).max(16).optional(),
  /** The client's downlink estimate, in kbit/s (`navigator.connection.downlink` × 1,000). */
  downlinkKbps: z.number().int().nonnegative().max(10_000_000).optional(),
  /** The client's round-trip estimate, in milliseconds. */
  rttMs: z.number().int().nonnegative().max(60_000).optional(),
  /** The person asked to save data (`Save-Data`, `navigator.connection.saveData`). */
  saveData: z.boolean().optional(),
  /** A cellular link or a hotspot (`NWPath.isExpensive`). */
  expensive: z.boolean().optional(),
  /** Low Data Mode (`NWPath.isConstrained`). */
  constrained: z.boolean().optional(),
});
export type MediaLinkHint = z.infer<typeof MediaLinkHint>;
