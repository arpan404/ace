import { z } from "zod";
const ref = z.string().min(1).max(256);
const delta = z.number().finite().min(-100_000).max(100_000);
/** Inputs shared by ordinary browser commands and measured interactions. */
export const BrowserInteractionAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("click"), ref }),
  z.strictObject({ action: z.literal("type"), ref, text: z.string().max(65_536) }),
  z.strictObject({ action: z.literal("press"), key: ref, ref: ref.optional() }),
  z.strictObject({ action: z.literal("scroll"), x: delta, y: delta }),
  z.strictObject({ action: z.literal("drag"), ref, toRef: ref }),
]);
export type BrowserInteractionAction = z.infer<typeof BrowserInteractionAction>;
