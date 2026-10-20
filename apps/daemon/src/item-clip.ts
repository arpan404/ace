import { Item } from "@ace/protocol";

/** Strings at most this long are never cut, so ids, kinds, statuses and paths stay whole. */
const floor = 256;

function cut(text: string, cap: number): string {
  if (text.length <= cap) return text;
  let end = cap;
  const last = text.charCodeAt(end - 1);
  // Never leave half a surrogate pair at the cut.
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}… [${text.length - end} more characters not shown]`;
}
function clipValue(value: unknown, cap: number): unknown {
  if (typeof value === "string") return cut(value, cap);
  if (Array.isArray(value)) return value.map((entry) => clipValue(entry, cap));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clipValue(entry, cap)]),
    );
  return value;
}
function longest(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value))
    return value.reduce((max: number, entry) => Math.max(max, longest(entry)), 0);
  if (value && typeof value === "object")
    return Object.values(value).reduce((max: number, entry) => Math.max(max, longest(entry)), 0);
  return 0;
}

/**
 * The item with every long string cut to the longest length that fits `maxBytes` of JSON, each
 * cut saying how much it left out. Undefined when even the shortest cut does not fit, or the
 * cut item no longer satisfies the item schema. Only for an item that alone exceeds a page.
 */
export function clipItem(item: Item, maxBytes: number): Item | undefined {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  let low = floor;
  let high = longest(item);
  if (high <= floor || size(clipValue(item, floor)) > maxBytes) return undefined;
  // The largest cap whose clipped item fits; each probe costs one bounded serialization.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(clipValue(item, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const parsed = Item.safeParse(clipValue(item, low));
  return parsed.success && size(parsed.data) <= maxBytes ? parsed.data : undefined;
}
