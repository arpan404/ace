import { z } from "zod";

/**
 * What ace-media's live video runs on (ADR 0148). Step and backend names stay open strings so a
 * newer daemon's names never fail an older client.
 */
const name = z.string().max(32);
const count = z.number().int().nonnegative().max(0xffffffff);

/** One probe result: a step and codec on a backend (`vt`, `mf`, `vaapi`, `nv`, `chrome`, `cpu`). */
export const MediaCapability = z.object({
  /** `encode`, `decode`, `jpeg-decode`, `jpeg-encode` or `scale`. */
  step: name,
  /** Absent for `scale`. */
  codec: z.string().max(64).optional(),
  backend: name,
  /** What the session itself reported, never inferred from the chip. */
  hardware: z.boolean(),
  /** The step's input arrives without a CPU copy. */
  zeroCopy: z.boolean(),
  /** `ok`, `timed-out` or `failed`. */
  state: name,
  maxWidth: count,
  maxHeight: count,
});
export type MediaCapability = z.infer<typeof MediaCapability>;

/** The steps one source runs, with the picture-sized copies each makes per frame. */
export const MediaAcceleration = z.object({
  steps: z
    .array(
      z.object({
        step: name,
        backend: name,
        hardware: z.boolean(),
        /** GPU → CPU picture copies per frame (per still for stills). */
        readbacks: count,
        /** CPU → GPU picture copies per frame. */
        uploads: count,
      }),
    )
    .max(16),
  /** Video encode isn't on hardware, or a step the probe found hardware for runs on the CPU. */
  degraded: z.boolean(),
  reason: z.string().max(256).optional(),
});
export type MediaAcceleration = z.infer<typeof MediaAcceleration>;
