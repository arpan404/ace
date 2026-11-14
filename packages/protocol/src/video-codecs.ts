import { z } from "zod";

/** A WebCodecs codec string (`avc1.42E033`, `vp8`, `vp09.00.10.08`). */
export const BrowserVideoCodec = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9.]+$/);
/**
 * A viewer that plays video (ADR 0088): the codecs its decoder supports, best first. The daemon
 * encodes the first one its encoder supports and sends JPEG frames otherwise.
 */
export const BrowserVideoRequest = z.object({ codecs: z.array(BrowserVideoCodec).min(1).max(8) });
export type BrowserVideoRequest = z.infer<typeof BrowserVideoRequest>;
