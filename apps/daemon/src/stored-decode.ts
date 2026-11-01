import { EventPayload, Item } from "@ace/protocol";
import { z } from "zod";

const tagged = z.looseObject({ type: z.string() });
/** Unknown persisted variants remain opaque, including the original discriminator and fields. */
export function decodeStoredPayload(value: unknown): EventPayload {
  const input = tagged.parse(value);
  if (input.type === "item.created" || input.type === "item.updated")
    return EventPayload.parse({ ...input, item: decodeStoredItem(input.item) });
  if (EventPayload.options.some((option) => option.shape.type.value === input.type))
    return EventPayload.parse(value);
  return EventPayload.parse({ type: "unknown", raw: value });
}
export function decodeStoredItem(value: unknown): Item {
  const input = tagged.parse(value);
  if (Item.options.some((option) => option.shape.type.value === input.type))
    return Item.parse(value);
  return Item.parse({ ...input, type: "unknown", raw: [], data: value });
}
