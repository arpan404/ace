import { z } from "zod";

/*
 * One-shot image jobs (ADR 0208): the `image.job` request and `image.done`/`image.failed`
 * answers, as `media_wire::image` holds them. Fixtures: `native/media/vectors/control/image.*`.
 */

const text = z.string().refine((value) => value.isWellFormed());
const id = text.refine((value) => Array.from(value).length <= 64);
const u32 = z.number().int().min(0).max(0xffffffff);
const i32 = z
  .number()
  .int()
  .min(-(2 ** 31))
  .max(2 ** 31 - 1);
const byte = z.number().int().min(0).max(255);

export const ImageInput = z.discriminatedUnion("kind", [
  /** The next `bytes` of the payload: an encoded image, its format sniffed by ace-media. */
  z.strictObject({ kind: z.literal("bytes"), bytes: u32 }),
  /** The next `bytes` of the payload: straight RGBA, 4 bytes a pixel. */
  z.strictObject({ kind: z.literal("rgba"), bytes: u32, width: u32, height: u32 }),
  /** A file ace wrote, read by ace-media; more than `maxBytes` is refused. */
  z.strictObject({ kind: z.literal("file"), path: text, maxBytes: u32 }),
]);
export type ImageInput = z.infer<typeof ImageInput>;

export const ImageOutput = z.discriminatedUnion("format", [
  z.strictObject({
    format: z.literal("jpeg"),
    quality: z.number().int().min(0).max(255),
    /** What alpha is flattened over; black when absent. */
    background: z.tuple([byte, byte, byte]).optional(),
  }),
  z.strictObject({ format: z.literal("png") }),
  /** Straight RGBA, 4 bytes a pixel. */
  z.strictObject({ format: z.literal("rgba") }),
]);
export type ImageOutput = z.infer<typeof ImageOutput>;

export const ImageLayer = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("image"),
    input: u32,
    left: i32,
    top: i32,
    width: u32,
    height: u32,
    fit: z.enum(["fill", "contain"]),
    /** An input whose alpha, drawn into the same box, multiplies this layer's. */
    mask: u32.optional(),
  }),
  z.strictObject({
    kind: z.literal("text"),
    text,
    left: i32,
    top: i32,
    size: u32,
    color: z.tuple([byte, byte, byte, byte]),
  }),
]);
export type ImageLayer = z.infer<typeof ImageLayer>;

export const ImageOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("probe"), maxPixels: u32 }),
  z.strictObject({
    op: z.literal("fit"),
    maxPixels: u32,
    width: u32,
    height: u32,
    autoOrient: z.boolean(),
    /** Pixels per SVG unit at most; 1 when absent. */
    vectorScale: z.number().positive().optional(),
    output: ImageOutput,
  }),
  z.strictObject({ op: z.literal("alpha"), maxPixels: u32 }),
  z.strictObject({
    op: z.literal("compose"),
    width: u32,
    height: u32,
    background: z.tuple([byte, byte, byte, byte]),
    maxPixels: u32,
    layers: z.array(ImageLayer),
    output: ImageOutput,
  }),
]);
export type ImageOp = z.infer<typeof ImageOp>;

export const SourceImage = z.strictObject({
  format: z.enum(["jpeg", "png", "webp", "gif", "ico", "svg", "rgba"]),
  width: u32,
  height: u32,
  orientation: z.number().int().min(1).max(8),
});
export type SourceImage = z.infer<typeof SourceImage>;

/** Why ace-media refused or dropped a job. */
export const ImageFailure = z.enum([
  "invalid",
  "too-large",
  "unsupported",
  "truncated",
  "decode-failed",
  "unreadable",
  "busy",
  "deadline",
  "cancelled",
  "shutdown",
]);
export type ImageFailure = z.infer<typeof ImageFailure>;

export const ImageToMedia = [
  z.strictObject({
    type: z.literal("image.job"),
    request: id,
    deadlineMs: u32,
    inputs: z.array(ImageInput),
    op: ImageOp,
  }),
  z.strictObject({ type: z.literal("image.cancel"), request: id }),
] as const;

export const ImageFromMedia = [
  z.strictObject({
    type: z.literal("image.done"),
    request: id,
    width: u32,
    height: u32,
    format: z.enum(["jpeg", "png", "alpha", "rgba", "none"]),
    source: SourceImage,
  }),
  z.strictObject({
    type: z.literal("image.failed"),
    request: id,
    reason: ImageFailure,
    message: text,
  }),
] as const;

/** The payload bytes an `image.job` carries: its `bytes` and `rgba` inputs, in order. */
export function imagePayloadBytes(inputs: readonly ImageInput[]): number {
  return inputs.reduce((sum, input) => sum + (input.kind === "file" ? 0 : input.bytes), 0);
}
