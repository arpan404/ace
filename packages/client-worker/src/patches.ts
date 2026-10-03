import type { SidebarReader, ThreadReader } from "@ace/client";
import type { Item } from "@ace/protocol";

/*
 * Fine-grained changes between a store in the worker and its mirror in a tab. A patch carries
 * the new value of one change key, read from the store when the frame flushes, so several
 * events touching one key cost one patch. A streaming message sends only the text it gained.
 */

export interface Patch {
  /** The store's change key, e.g. `item:abc` or `order`. */
  k: string;
  /** The key's value now; absent when the entity is gone. */
  v?: unknown;
  /**
   * Text appended to what the mirror already holds: the last text part of a message, or the
   * text of a reasoning or notice item.
   */
  append?: string | undefined;
  /** Item keys only: the item holds a prefix of its full text (ThreadReader.truncated). */
  cut?: boolean | undefined;
}

/** Ids and parent links of a thread's agents: what the "agents" key covers. */
export interface AgentLinks {
  ids: readonly string[];
  children: Record<string, readonly string[]>;
}

/** Split `prefix:id` keys at the first colon; ids may contain colons themselves. */
export function splitKey(key: string): { kind: string; id: string } {
  const colon = key.indexOf(":");
  return colon < 0
    ? { kind: key, id: "" }
    : { kind: key.slice(0, colon), id: key.slice(colon + 1) };
}

export function agentLinks(reader: ThreadReader): AgentLinks {
  const ids = reader.agentIds();
  const children: Record<string, readonly string[]> = {};
  for (const id of ids) {
    const list = reader.children(id);
    if (list.length) children[id] = list;
  }
  return { ids, children };
}

/** The value a thread key stands for, as a mirror stores it. */
export function threadValue(reader: ThreadReader, key: string): unknown {
  const { kind, id } = splitKey(key);
  switch (kind) {
    case "error":
      return reader.error && { code: reader.error.code, message: reader.error.message };
    case "thread":
      return reader.thread;
    case "queue":
      return reader.queue;
    case "order":
      return reader.order;
    case "cursor":
      return reader.cursor;
    case "history":
      return reader.itemsBefore;
    case "agents":
      return agentLinks(reader);
    case "interactions":
      return reader.interactionIds();
    case "tasks":
      return reader.taskIds();
    case "item":
      return reader.item(id);
    case "agent":
      return reader.agent(id);
    case "run":
      return reader.run(id);
    case "interaction":
      return reader.interaction(id);
    case "task":
      return reader.task(id);
    case "context":
      return reader.contextMeter(id);
    case "usage":
      return reader.usage(id);
    case "usageSnapshot":
      return reader.usageSnapshot(id);
    default:
      return undefined;
  }
}

type Message = Extract<Item, { type: "message" }>;

/**
 * Text `next` appended to `previous`'s last text part, when that is the only difference.
 * Every other field and part must be the same object, which is how the client's delta path
 * builds the next message; anything else is sent whole.
 */
export function appendedText(previous: Item | undefined, next: Item | undefined) {
  if (previous && next && previous.type === next.type && hasText(previous) && hasText(next))
    return appendedField(previous, next);
  if (previous?.type !== "message" || next?.type !== "message") return undefined;
  for (const field of Object.keys(next) as (keyof Message)[])
    if (field !== "parts" && !Object.is(previous[field], next[field])) return undefined;
  const before = previous.parts;
  const after = next.parts;
  if (before.length !== after.length || !after.length) return undefined;
  const last = after.length - 1;
  for (let index = 0; index < last; index++)
    if (!Object.is(before[index], after[index])) return undefined;
  const old = before[last];
  const now = after[last];
  if (old?.type !== "text" || now?.type !== "text" || old.source !== now.source) return undefined;
  if (now.text.length <= old.text.length || !now.text.startsWith(old.text)) return undefined;
  return now.text.slice(old.text.length);
}

type TextItem = Extract<Item, { type: "reasoning" | "notice" }>;
/** Reasoning and notices stream into one `text` field. */
export function hasText(item: Item): item is TextItem {
  return item.type === "reasoning" || item.type === "notice";
}
function appendedField(previous: TextItem, next: TextItem): string | undefined {
  for (const field of Object.keys(next) as (keyof TextItem)[])
    if (field !== "text" && !Object.is(previous[field], next[field])) return undefined;
  if (next.text.length <= previous.text.length || !next.text.startsWith(previous.text))
    return undefined;
  return next.text.slice(previous.text.length);
}

/**
 * Patches for changed thread keys. `sent` holds the last item each mirror received, so a
 * streaming message becomes an append; it is updated as patches are made.
 */
export function threadPatches(
  reader: ThreadReader,
  keys: Iterable<string>,
  sent: Map<string, Item>,
): Patch[] {
  const patches: Patch[] = [];
  for (const k of keys) {
    const { kind, id } = splitKey(k);
    if (kind !== "item") {
      const v = threadValue(reader, k);
      patches.push(v === undefined ? { k } : { k, v });
      continue;
    }
    const item = reader.item(id);
    const cut = reader.truncated(id);
    const append = appendedText(sent.get(id), item);
    if (item) sent.set(id, item);
    else sent.delete(id);
    if (append !== undefined) patches.push({ k, append, cut });
    else patches.push(item ? { k, v: item, cut } : { k, cut });
  }
  return patches;
}

/** Patches for changed thread-list keys. */
export function sidebarPatches(reader: SidebarReader, keys: Iterable<string>): Patch[] {
  const patches: Patch[] = [];
  for (const k of keys) {
    // The mirror derives `threads` from the entry and membership patches it applies.
    if (k === "threads") continue;
    const { kind, id } = splitKey(k);
    const v =
      kind === "ids"
        ? reader.ids
        : kind === "thread"
          ? reader.thread(id)
          : reader.error && { code: reader.error.code, message: reader.error.message };
    patches.push(v === undefined ? { k } : { k, v });
  }
  return patches;
}
