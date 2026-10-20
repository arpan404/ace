import type { Item, ItemsPage, OmittedItem } from "@ace/protocol";
import { ItemPageCapacityExceeded } from "./item-page-capacity.ts";
import { clipItem } from "./item-clip.ts";

/** What a bounded page reads from: a store page and the single item it could not start with. */
export interface ItemPageSource {
  /** Throws `ItemPageCapacityExceeded` when the newest item before `before` alone exceeds it. */
  page(before: number, limit: number, byteLimit: number): Omit<ItemsPage, "seq" | "threadId">;
  newestBefore(before: number): { item: Item; seq: number } | undefined;
  hasItemBefore(before: number): boolean;
}
export type BoundedItemPage = Omit<ItemsPage, "seq">;
type Parts = {
  items: Item[];
  itemSeqs: Record<string, number>;
  omitted: OmittedItem[];
  itemsBefore: number | null;
};

/** The envelope bytes every store page reserves for itself. */
const envelope = 512;
const entryBytes = (value: unknown, id: string) =>
  Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(JSON.stringify(id)) + 64;

/** The item without its verbatim provider payloads, the part that makes tool calls huge. */
function withoutRaw(item: Item): Item {
  if (item.type === "tool_call") return { ...item, call: { ...item.call, raw: [] } };
  return "raw" in item ? { ...item, raw: [] } : item;
}
function summary(
  item: Item,
  seq: number,
  bytes: number,
  dropped: OmittedItem["dropped"],
): OmittedItem {
  return {
    itemId: item.id,
    seq,
    type: item.type,
    bytes,
    dropped,
    ...(item.type === "tool_call"
      ? { kind: item.call.kind, title: Array.from(item.call.title).slice(0, 200).join("") }
      : {}),
  };
}

/**
 * A page that never fails on one oversized item. The store refuses to start a page with an item
 * larger than the page; here that item is shown without its raw payloads, then with its long
 * strings cut to fit, and only if neither fits is it left to its summary. Every such item is
 * listed in `omitted`, and paging continues past it. `itemsBefore` stays the exclusive
 * creation cursor of the oldest entry, and is null only when nothing earlier exists.
 */
export function boundedItemPage(
  source: ItemPageSource,
  threadId: BoundedItemPage["threadId"],
  before: number,
  limit: number,
  byteLimit: number,
): BoundedItemPage {
  const parts = fill(source, before, limit, byteLimit, byteLimit);
  return {
    threadId,
    items: parts.items,
    itemSeqs: parts.itemSeqs,
    itemsBefore: parts.itemsBefore,
    ...(parts.omitted.length ? { omitted: parts.omitted } : {}),
  };
}

function fill(
  source: ItemPageSource,
  before: number,
  limit: number,
  budget: number,
  full: number,
): Parts {
  // Newer entries spent part of this page: the next page starts here with the whole budget.
  const stop = (): Parts => ({
    items: [],
    itemSeqs: {},
    omitted: [],
    itemsBefore: source.hasItemBefore(before) ? before : null,
  });
  if (budget < full && budget <= envelope) return stop();
  try {
    const page = source.page(before, limit, budget);
    return {
      items: page.items,
      itemSeqs: page.itemSeqs ?? {},
      omitted: [],
      itemsBefore: page.itemsBefore,
    };
  } catch (error) {
    if (!(error instanceof ItemPageCapacityExceeded)) throw error;
    if (budget < full) return stop();
    const newest = source.newestBefore(before);
    if (!newest) throw error;
    const { item, seq } = newest;
    const bytes = Buffer.byteLength(JSON.stringify(item));
    const marker = Buffer.byteLength(JSON.stringify(summary(item, seq, bytes, "item"))) + 1;
    const room = budget - envelope - marker;
    const slim = withoutRaw(item);
    const clipped =
      entryBytes(slim, item.id) <= room
        ? undefined
        : clipItem(slim, room - entryBytes("", item.id) + 2);
    const shown = clipped ?? (entryBytes(slim, item.id) <= room ? slim : undefined);
    const omission = summary(item, seq, bytes, clipped ? "text" : shown ? "raw" : "item");
    const used = (shown ? entryBytes(shown, item.id) : 0) + marker;
    const rest: Parts =
      limit > 1
        ? fill(source, seq, limit - 1, budget - used, full)
        : {
            items: [],
            itemSeqs: {},
            omitted: [],
            itemsBefore: source.hasItemBefore(seq) ? seq : null,
          };
    return {
      items: shown ? [...rest.items, shown] : rest.items,
      itemSeqs: shown ? { ...rest.itemSeqs, [item.id]: seq } : rest.itemSeqs,
      omitted: [...rest.omitted, omission],
      itemsBefore: rest.itemsBefore,
    };
  }
}
