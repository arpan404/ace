import { applyDelta } from "@ace/projection";
import type { Item, ContentPart } from "@ace/protocol";
type Message = Extract<Item, { type: "message" }>;
type Text = Extract<ContentPart, { type: "text" }>;
interface Tail {
  prefix: ContentPart[];
  tail: Text | undefined;
  prefixUnits: number;
}
function shell(item: Message, parts: ContentPart[]): Message {
  return {
    type: "message",
    id: item.id,
    agentId: item.agentId,
    ...(item.runId === undefined ? {} : { runId: item.runId }),
    createdAt: item.createdAt,
    complete: item.complete,
    role: item.role,
    synthetic: item.synthetic,
    raw: item.raw,
    parts,
  };
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
      };
    }
    const temporary = shell(item, previous.tail ? [{ ...previous.tail }] : []);
    applyDelta(temporary, "text", append);
    const last = temporary.parts.at(-1);
    if (last?.type !== "text") throw new Error("Projection did not append text");
    let { prefix, prefixUnits } = previous;
    if (prefix.length + 1 > partLimit) {
      prefix = prefix.slice(-(partLimit - 1 || 0));
      if (partLimit === 1) prefix = [];
      prefixUnits = prefix.reduce(
        (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
        0,
      );
      clipped();
    }
    if (prefixUnits + last.text.length > textLimit) {
      prefix = prefix.filter((part) => part.type !== "text" || part.text.length === 0);
      prefixUnits = 0;
      last.text = last.text.slice(-Math.max(1, Math.floor(textLimit / 2)));
      clipped();
    }
    const next = shell(item, []);
    let parts: ContentPart[] | undefined;
    Object.defineProperty(next, "parts", {
      enumerable: true,
      configurable: true,
      get: () => (parts ??= [...prefix, last]),
    });
    this.#tails.set(next, { prefix, tail: last, prefixUnits });
    return next;
  }
  /**
   * Whether appends alone made `next` from `previous`, so its last text part is the earlier
   * one's text plus what was appended. A run of appends shares one prefix array; every clip
   * makes a new one.
   */
  appended(previous: object, next: object): boolean {
    const run = this.#tails.get(previous)?.prefix;
    return !!run && run === this.#tails.get(next)?.prefix;
  }
}
