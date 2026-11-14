import { z } from "zod";

/*
 * What a client says about its link (ADR 0149, K3). It is the client's word and only advice: it
 * picks where a viewer's video starts (lower, never higher) and never moves a rate the link has
 * measured. So it is never fatal. A number is rounded and clamped, any field that still doesn't
 * parse reads as absent, and a `link` that isn't an object reads as no hint at all; the message
 * carrying it parses either way.
 *
 * - The web: `navigator.connection` (`effectiveType`, `downlink` in kbit/s, `rtt`, `saveData`)
 *   and the `Save-Data` preference.
 * - iOS: `NWPath` `isExpensive` and `isConstrained`, with the round trip the app measured.
 *
 * Forwarding to ace-media: the wire's `LinkHint` (`@ace/media/wire`) is strict, so the daemon
 * builds it field by field from this parsed hint, never by passing the client's object through.
 */

// Unions with an `unknown()` fallback, not `.catch()`: browser workers load these schemas and
// leave `.catch()` out. Each fallback reads a value that doesn't parse as absent.
const ignoredMeta = "A value that doesn't parse is ignored, as if absent.";
const ignoredString = z
  .unknown()
  .transform(() => undefined)
  .meta({ "x-ace-json-input": z.string(), "x-ace-constraint": ignoredMeta });
const ignoredNumber = z
  .unknown()
  .transform(() => undefined)
  .meta({ "x-ace-json-input": z.number(), "x-ace-constraint": ignoredMeta });
const ignoredBoolean = z
  .unknown()
  .transform(() => undefined)
  .meta({ "x-ace-json-input": z.boolean(), "x-ace-constraint": ignoredMeta });
/** A flag the client may set; anything but a boolean reads as absent. */
const flag = z.union([z.boolean(), ignoredBoolean]).optional();
/** A number rounded to a whole one and clamped into range; anything else reads as absent. */
const downlinkKbps = z
  .union([
    z
      .number()
      .finite()
      .transform((value) => Math.min(10_000_000, Math.max(0, Math.round(value))))
      .meta({
        "x-ace-json-input": z.number(),
        "x-ace-constraint": "Rounded to a whole number and clamped to 0–10000000.",
      }),
    ignoredNumber,
  ])
  .optional();
const rttMs = z
  .union([
    z
      .number()
      .finite()
      .transform((value) => Math.min(60_000, Math.max(0, Math.round(value))))
      .meta({
        "x-ace-json-input": z.number(),
        "x-ace-constraint": "Rounded to a whole number and clamped to 0–60000.",
      }),
    ignoredNumber,
  ])
  .optional();

const LinkHintFields = z.object({
  /** `slow-2g`, `2g`, `3g` or `4g` today; an open string, so a later value still parses. */
  effectiveType: z.union([z.string().min(1).max(16), ignoredString]).optional(),
  /** The client's downlink estimate, in kbit/s (`navigator.connection.downlink` × 1,000). */
  downlinkKbps,
  /** The client's round-trip estimate, in milliseconds. */
  rttMs,
  /** The person asked to save data (`Save-Data`, `navigator.connection.saveData`). */
  saveData: flag,
  /** A cellular link or a hotspot (`NWPath.isExpensive`). */
  expensive: flag,
  /** Low Data Mode (`NWPath.isConstrained`). */
  constrained: flag,
});
const ignoredHint = z
  .unknown()
  .transform(() => undefined)
  .meta({
    "x-ace-json-input": LinkHintFields,
    "x-ace-constraint": "A link that isn't an object is ignored, as if there were no hint.",
  });

export const MediaLinkHint = z.union([LinkHintFields, ignoredHint]);
export type MediaLinkHint = z.infer<typeof LinkHintFields>;
