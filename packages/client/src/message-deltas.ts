import { applyDelta } from "@ace/projection";
import { dropFront } from "./item-window.ts";
import type { Item, ContentPart } from "@ace/protocol";
type Message = Extract<Item, { type: "message" }>;
type Text = Extract<ContentPart, { type: "text" }>;
interface Tail {
  prefix: ContentPart[];
  tail: Text | undefined;
  prefixUnits: number;
  /** Units this run has dropped from the front of its tail text so far. */
  dropped: number;
}
function shell(item: Message, parts: ContentPart[]): Message {
  // Copy descriptors so replacing a lazy parts getter never materializes the old prefix.
  const { parts: _parts, ...metadata } = Object.getOwnPropertyDescriptors(item);
  const next: Message = {
    type: item.type,
    id: item.id,
    agentId: item.agentId,
    createdAt: item.createdAt,
    complete: item.complete,
    role: item.role,
    synthetic: item.synthetic,
    raw: item.raw,
    parts,
  };
  return Object.defineProperties(next, metadata);
}
/** Immutable tails keep application O(append); materialize the full parts array on read.
 * Prefixes are shared, never chained through previous items. Weak keys do not retain history. */
export class MessageDeltas {
  #tails = new WeakMap<object, Tail>();
  append(
    item: Message,
    append: string,
    textLimit: number,
    partLimit: number,
    clipped: () => void,
  ): Message {
    let previous = this.#tails.get(item);
    if (!previous) {
      const parts = item.parts;
      const last = parts.at(-1);
      const tail = last?.type === "text" ? last : undefined;
      const prefix = tail ? parts.slice(0, -1) : parts;
      previous = {
        prefix,
        tail,
        prefixUnits: prefix.reduce(
          (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
          0,
        ),
        dropped: 0,
      };
    }
    const temporary = shell(item, previous.tail ? [{ ...previous.tail }] : []);
    applyDelta(temporary, "text", append);
    const last = temporary.parts.at(-1);
    if (last?.type !== "text") throw new Error("Projection did not append text");
    let { prefix, prefixUnits, dropped } = previous;
    if (prefix.length + 1 > partLimit) {
      prefix = prefix.slice(-(partLimit - 1 || 0));
      if (partLimit === 1) prefix = [];
      prefixUnits = prefix.reduce(
        (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
        0,
      );
      clipped();
    }
    if (prefixUnits && prefixUnits + last.text.length > textLimit) {
      // Earlier text parts go first, once; a new prefix starts a new run.
      prefix = prefix.filter((part) => part.type !== "text" || part.text.length === 0);
      prefixUnits = 0;
      dropped = 0;
      clipped();
    }
    const over = last.text.length - Math.max(1, textLimit);
    if (over > 0) {
      // Slide: drop only what this delta pushed past the bound, so the newest text always shows.
      const cut = dropFront(last, over);
      dropped += cut;
      clipped();
    }
    const next = shell(item, []);
    let parts: ContentPart[] | undefined;
    Object.defineProperty(next, "parts", {
      enumerable: true,
      configurable: true,
      get: () => (parts ??= [...prefix, last]),
    });
    this.#tails.set(next, { prefix, tail: last, prefixUnits, dropped });
    return next;
  }
  /**
   * How `next` was made from `previous` by appends alone: its last text part is the earlier one's
   * with `dropped` units removed from the front and `append` added. A run of appends shares one
   * prefix array; dropping earlier parts makes a new one. Undefined for any other change.
   */
  edit(previous: object, next: object): { dropped: number } | undefined {
    const before = this.#tails.get(previous);
    const after = this.#tails.get(next);
    if (!before || !after || before.prefix !== after.prefix || after.dropped < before.dropped)
      return undefined;
    return { dropped: after.dropped - before.dropped };
  }
}
