import type { Item, ServerMessage, Thread, ThreadListEntry } from "@ace/protocol";
import type { PluginServerMessage } from "@ace/protocol/plugins";

/*
 * Bytes a snapshot or page repeats for every item and thread, left out for a client that says it
 * can put them back (`hello.trims`). Both sides are pure and keep their own per-connection
 * state, so the daemon, the fake daemon and the client share one definition of the trim.
 *
 * Only bulk reads are trimmed (snapshots, thread list patches, item pages). Live events are
 * encoded once and shared by every connection, so they stay whole.
 */

export const wireTrims = {
  /** Items leave out `complete: true`, `synthetic: false` and an empty `raw`. */
  itemDefaults: "item-defaults",
  /** Threads name their provider's capabilities by a key sent once per connection. */
  providerCapabilities: "provider-capabilities",
} as const;
/** Every trim this build can undo; what a client lists in its hello. */
export const supportedWireTrims: readonly string[] = Object.values(wireTrims);

type Capabilities = NonNullable<Thread["capabilities"]>;
type Outgoing = ServerMessage | PluginServerMessage;
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

function mapRecord<T>(record: Record<string, T>, change: (value: T) => T): Record<string, T> {
  // Own data properties, so an id such as `__proto__` survives.
  return Object.fromEntries(Object.entries(record).map(([id, value]) => [id, change(value)]));
}

/** What the daemon sends one connection, given the trims its hello asked for. */
export class WireTrimmer {
  readonly #items: boolean;
  readonly #capabilities: boolean;
  readonly #keys = new Map<string, string>();
  constructor(trims: readonly string[] | undefined) {
    this.#items = trims?.includes(wireTrims.itemDefaults) === true;
    this.#capabilities = trims?.includes(wireTrims.providerCapabilities) === true;
  }
  /** `message` as this connection should receive it, behind any capabilities it now needs. */
  outgoing(message: Outgoing): Outgoing[] {
    if (!this.#items && !this.#capabilities) return [message];
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
              items: this.#items ? mapRecord(view.items, trimItem) : view.items,
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
        return this.#items ? { ...message, items: message.items.map(trimItem) } : message;
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
    if (capabilities !== undefined) thread.capabilities = structuredClone(capabilities);
  }
}
