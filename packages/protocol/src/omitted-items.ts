import { z } from "zod";
import { ItemId } from "./ids.ts";

/**
 * An item a page left out, in whole or in part, because it alone is larger than the page allows.
 * `dropped: "raw"`: the item is in `items` without its verbatim provider payloads. `"text"`: it is
 * there without them and with its long strings cut, each cut saying how much it left out.
 * `"item"`: only this summary stands in for it. The stored item is unchanged.
 */
export const OmittedItem = z.object({
  itemId: ItemId,
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: z.string().min(1).max(64),
  bytes: z.number().int().nonnegative(),
  dropped: z.enum(["raw", "text", "item"]),
  /** For a tool call: its kind and the start of its one-line title. */
  kind: z.string().max(64).optional(),
  title: z.string().max(256).optional(),
});
export type OmittedItem = z.infer<typeof OmittedItem>;
