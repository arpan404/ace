import type { StreamState } from "./content.ts";
import { string, type Data } from "./native.ts";

/** Stable child identities contain only ids, hashes and stream indices, never payloads. */
export interface MessageBlocks {
  id: string;
  next: number;
  identities: Map<string, number>;
}
export class MessageIndex {
  #root: string;
  #rootMessage: MessageBlocks | undefined;
  #children = new Map<string, Map<string, MessageBlocks>>();
  constructor(root: string) {
    this.#root = root;
  }
  forMessage(agent: string, id: string): MessageBlocks {
    if (agent === this.#root) {
      if (this.#rootMessage?.id !== id) this.#rootMessage = this.#create(id);
      return this.#rootMessage;
    }
    let messages = this.#children.get(agent);
    if (!messages) {
      messages = new Map();
      this.#children.set(agent, messages);
    }
    const prior = messages.get(id);
    if (prior) return prior;
    const current = this.#create(id);
    messages.set(id, current);
    return current;
  }
  endRoot(): void {
    this.#rootMessage = undefined;
  }
  clear(): void {
    this.endRoot();
    this.#children.clear();
  }
  #create(id: string): MessageBlocks {
    return { id, next: 0, identities: new Map() };
  }
}
export function matchBlock(
  current: MessageBlocks,
  block: Data,
  index: number,
  uuid: string,
  stream?: StreamState,
): number {
  // UUID identifies separate native blocks even when their text is identical.
  const identity = uuid ? `${uuid}:${index}` : `${index}:${fingerprint(block)}`;
  const prior = current.identities.get(identity);
  if (prior !== undefined) return prior;
  const kind = string(block["type"]);
  const cursor = stream?.cursors.get(kind) ?? 0;
  const streamed = stream?.unmatched.get(kind)?.[cursor];
  if (streamed !== undefined) stream?.cursors.set(kind, cursor + 1);
  const result = streamed ?? current.next;
  current.next = Math.max(current.next, result + 1);
  current.identities.set(identity, result);
  return result;
}

// Retain a fixed-size identity, never the block's text or native payload.
function fingerprint(block: Data): string {
  const value = ["type", "id", "text", "thinking", "signature"]
    .map((key) => string(block[key]))
    .join("\0");
  let first = 2166136261;
  let second = 5381;
  for (let i = 0; i < value.length; i++) {
    first = Math.imul(first ^ value.charCodeAt(i), 16777619);
    second = Math.imul(second, 33) ^ value.charCodeAt(i);
  }
  return `${value.length}:${first >>> 0}:${second >>> 0}`;
}
