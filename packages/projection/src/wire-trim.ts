import type { Item, ServerMessage, Thread, ThreadListEntry } from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";
import type { SuitServerMessage } from "@ace/protocol/suits";
import { historyMessageIdentity, isRawHistoryItem } from "./history-visibility.ts";
import { providerNotice } from "./provider-notices.ts";
import { structuredCopy } from "./structured-copy.ts";

/*
 * Bytes a snapshot or page repeats for every item and thread, left out for a client that says it
 * can put them back (`hello.trims`). Both sides are pure and keep their own per-connection
 * state, so the daemon, the fake daemon and the client share one definition of the trim.
 *
 * Only bulk reads are trimmed here (snapshots, thread list patches, item pages and windows,
 * turn steps). Live events are encoded once and shared by every connection; the daemon keeps a
 * second encoding of an item event without its raw payloads (`omitRaw`) for clients that ask.
 */

export const wireTrims = {
  /** Accepts the hidden Spade error code and live-end reason. */
  spadeHidden: "spade-hidden",
  /** Items leave out `complete: true`, `synthetic: false` and an empty `raw`. */
  itemDefaults: "item-defaults",
  /** Threads name their provider's capabilities by a key sent once per connection. */
  providerCapabilities: "provider-capabilities",
  /**
   * Items whose raw payloads clients only show leave them out, marked `rawOmitted`; the
   * raw-frames view reads them with `item.raw`.
   */
  rawOnDemand: "raw-on-demand",
} as const;
/** Every trim this build can undo; what a client lists in its hello. */
export const supportedWireTrims: readonly string[] = Object.values(wireTrims);

type Capabilities = NonNullable<Thread["capabilities"]>;
type Outgoing = ServerMessage | PluginServerMessage | SuitServerMessage;
type Listed = Thread | ThreadListEntry;

/** More distinct capability sets than this on one connection are sent whole, not keyed. */
const maxCapabilityKeys = 64;

/** An item without the fields a reader's schema fills back in. */
export function trimItem(item: Item): Item {
  const copy: Record<string, unknown> = { ...item };
  if (copy.complete === true) delete copy.complete;
  if (copy.synthetic === false) delete copy.synthetic;
  if (Array.isArray(copy.raw) && copy.raw.length === 0) delete copy.raw;
  // Same data minus defaulted fields: the schema's defaults restore exactly `item`.
  return copy as unknown as Item;
}

/**
 * Whether clients only ever show this item's raw payloads, in its raw-frames view. They read the
 * rest for what a step says or whether and how it shows, so those keep theirs:
 * - notices (refusals, delivery errors, screen steps, retries, diagnostics, native stderr);
 * - tool calls that may be ace's own (MCP and custom calls, whose results, arguments and
 *   measurements are read from `call.raw`);
 * - messages whose raw decides what the transcript shows: a provider's system message it hides,
 *   the native identity that folds a replayed answer into the first, the native source of a
 *   legacy provider notice. Asked of the readers themselves, so the rule follows them.
 */
export function rawShownOnly(item: Item): boolean {
  if (item.type === "notice" || item.type === "artifact") return false;
  if (item.type === "message") return !messageRawRead(item);
  if (item.type !== "tool_call") return true;
  const { call } = item;
  return call.kind !== "custom" && call.detail.kind !== "mcp" && call.detail.kind !== "custom";
}

/** Whether a reader of what a message is would answer differently without its raw payloads. */
function messageRawRead(item: Extract<Item, { type: "message" }>): boolean {
  if (!item.raw.length) return false;
  const bare: Item = { ...item, raw: [] };
  return (
    isRawHistoryItem(item) !== isRawHistoryItem(bare) ||
    historyMessageIdentity(item) !== historyMessageIdentity(bare) ||
    providerNotice(item) !== providerNotice(bare)
  );
}

/** `item` without raw payloads clients only show, marked so a view can read them back. */
export function omitRaw(item: Item): Item {
  if (!rawShownOnly(item)) return item;
  if (item.type === "tool_call")
    return item.call.raw.length
      ? { ...item, rawOmitted: true, call: { ...item.call, raw: [] } }
      : item;
  if (!("raw" in item) || !item.raw.length) return item;
  return { ...item, raw: [], rawOmitted: true };
}

function mapRecord<T>(record: Record<string, T>, change: (value: T) => T): Record<string, T> {
  // Own data properties, so an id such as `__proto__` survives.
  return Object.fromEntries(Object.entries(record).map(([id, value]) => [id, change(value)]));
}

/** What the daemon sends one connection, given the trims its hello asked for. */
export class WireTrimmer {
  readonly #hidden: boolean;
  readonly #items: boolean;
  readonly #capabilities: boolean;
  readonly #raw: boolean;
  readonly #keys = new Map<string, string>();
  constructor(trims: readonly string[] | undefined) {
    this.#hidden = trims?.includes(wireTrims.spadeHidden) === true;
    this.#items = trims?.includes(wireTrims.itemDefaults) === true;
    this.#capabilities = trims?.includes(wireTrims.providerCapabilities) === true;
    this.#raw = trims?.includes(wireTrims.rawOnDemand) === true;
  }
  /** An item as this connection receives it. */
  #item = (item: Item): Item => {
    const kept = this.#raw ? omitRaw(item) : item;
    return this.#items ? trimItem(kept) : kept;
  };
  /** `message` as this connection should receive it, behind any capabilities it now needs. */
  outgoing(message: Outgoing): Outgoing[] {
    if (!this.#hidden) {
      if (message.type === "spade.live.ended" && message.reason === "hidden")
        message = { ...message, reason: "unavailable" };
      if (
        message.type === "spade.http.result" &&
        message.result.kind === "error" &&
        message.result.code === "hidden"
      )
        message = { ...message, result: { ...message.result, code: "unavailable" } };
    }
    if (!this.#items && !this.#capabilities && !this.#raw) return [message];
    const before: Outgoing[] = [];
    const trimmed = this.trim(message, before);
    return [...before, trimmed];
  }
  private trim(message: Outgoing, before: Outgoing[]): Outgoing {
    switch (message.type) {
      case "snapshot": {
        const { view } = message;
        if (view.kind === "thread")
          return {
            ...message,
            view: {
              ...view,
              thread: this.thread(view.thread, before),
              items: this.#items || this.#raw ? mapRecord(view.items, this.#item) : view.items,
            },
          };
        return {
          ...message,
          view: {
            ...view,
            threads: mapRecord(view.threads, (entry) => this.thread(entry, before)),
          },
        };
      }
      case "threads.patch":
        return {
          ...message,
          threads: mapRecord(message.threads, (entry) => this.thread(entry, before)),
        };
      case "items.page":
      case "items.window":
        return this.#items || this.#raw
          ? { ...message, items: message.items.map(this.#item) }
          : message;
      case "turn.steps":
        return this.#items || this.#raw
          ? {
              ...message,
              steps: message.steps.map((step) => ({ ...step, item: this.#item(step.item) })),
            }
          : message;
      default:
        return message;
    }
  }
  private thread<T extends Listed>(thread: T, before: Outgoing[]): T {
    if (!this.#capabilities || thread.capabilities === undefined) return thread;
    const { capabilities, ...rest } = thread;
    const text = JSON.stringify(capabilities);
    let key = this.#keys.get(text);
    if (key === undefined) {
      if (this.#keys.size >= maxCapabilityKeys) return thread;
      key = `c${this.#keys.size + 1}`;
      this.#keys.set(text, key);
      before.push({ type: "provider.capabilities", key, capabilities });
    }
    // The same thread without its capabilities, naming them instead: a reader restores them.
    return { ...rest, capabilitiesRef: key } as T;
  }
}

/** What a client does with the trimmed messages of its connection. */
export class WireRestorer {
  readonly #capabilities = new Map<string, Capabilities>();
  /**
   * The message to hand on with every trimmed thread whole again, or undefined for a message
   * that only taught this restorer a key. Item defaults need no work here: the schemas that
   * decoded the message already filled them in.
   */
  restore(message: ServerMessage): ServerMessage | undefined {
    switch (message.type) {
      case "provider.capabilities":
        this.#capabilities.set(message.key, message.capabilities);
        return undefined;
      case "snapshot":
        if (message.view.kind === "thread") this.thread(message.view.thread);
        else for (const entry of Object.values(message.view.threads)) this.thread(entry);
        return message;
      case "threads.patch":
        for (const entry of Object.values(message.threads)) this.thread(entry);
        return message;
      default:
        return message;
    }
  }
  private thread(thread: Listed): void {
    const key = thread.capabilitiesRef;
    if (key === undefined) return;
    delete thread.capabilitiesRef;
    const capabilities = this.#capabilities.get(key);
    if (capabilities !== undefined) thread.capabilities = structuredCopy(capabilities);
  }
}
