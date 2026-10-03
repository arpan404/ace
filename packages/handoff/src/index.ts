import { PortableHandoff, type Item, type ThreadId } from "@ace/protocol";

export interface HandoffSource {
  threadId: ThreadId;
  throughSeq: number;
  totalItems: number;
  /** Bounded previews in chronological order, supplied by the storage owner. */
  items: readonly Item[];
  origin?: PortableHandoff["origin"];
}
const encoder = new TextEncoder();
export function handoffBytes(value: PortableHandoff): number {
  return encoder.encode(JSON.stringify(value)).length;
}
function excerpt(item: Item): string {
  switch (item.type) {
    case "message": {
      let text = `${item.role}: `;
      let first = true;
      for (const part of item.parts) {
        if (!first && text.length < 8192) text += "\n";
        first = false;
        const available = 8192 - text.length;
        if (available <= 0) break;
        const value =
          part.type === "text"
            ? part.text
            : part.type === "file"
              ? `[file: ${part.path.slice(0, available)}]`
              : `[image: ${part.url.slice(0, available)}]`;
        text += value.slice(0, available);
      }
      return text;
    }
    case "reasoning":
      return `Reasoning excerpt: ${item.text.slice(0, 8192)}`;
    case "notice":
      return `Notice: ${item.text.slice(0, 8192)}`;
    case "tool_call":
      return `Tool ${item.call.title.slice(0, 8000)}: ${item.call.status}. Full input/result available through history.`;
    case "artifact":
      return `Artifact: ${item.path.slice(0, 8000)} (${item.mimeType.slice(0, 128)})`;
    case "compaction":
      return "Provider compacted history at this item.";
  }
}
/** Cold, bounded selection. No I/O, clock, tokenizer assumptions or provider checks. */
export function selectHandoff(source: HandoffSource, budgetBytes: number): PortableHandoff {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1024 || budgetBytes > 262144)
    throw new Error("Handoff budget must be 1024..262144 bytes");
  if (source.items.length > 200 || source.totalItems < source.items.length)
    throw new Error("Invalid bounded handoff inventory");
  const result = PortableHandoff.parse({
    version: 1,
    sourceThreadId: source.threadId,
    ...(source.origin ? { origin: source.origin } : {}),
    throughSeq: source.throughSeq,
    lossy: true,
    policy: "recent-complete-items",
    excerpts: [],
    omittedItems: source.totalItems,
    history: {
      type: "items.page",
      threadId: source.threadId,
      before: source.throughSeq + 1,
      limit: 50,
    },
    limitations:
      "Provider-private state is unavailable. Page history for omitted items, full text, reasoning, tools and attachments.",
  });
  // Count once, then admit each excerpt by its encoded cost. No growing-history serialization.
  let bytes = handoffBytes(result);
  if (bytes > budgetBytes) throw new Error("Handoff manifest exceeds budget");
  for (let index = source.items.length - 1; index >= 0; index--) {
    const item = source.items[index];
    if (!item?.complete) continue;
    const entry = {
      citation: { threadId: source.threadId, itemId: item.id },
      text: excerpt(item).slice(0, 8192),
    };
    const cost = encoder.encode(JSON.stringify(entry)).length + (result.excerpts.length ? 1 : 0);
    // Reserve digit changes in omittedItems; its count only decreases.
    if (bytes + cost > budgetBytes) continue;
    bytes += cost;
    result.excerpts.push(entry);
    result.omittedItems--;
  }
  result.excerpts.reverse();
  return result;
}
/** Quote external context as data; preserve citations and paging instructions verbatim. */
export function renderHandoff(handoff: PortableHandoff): string {
  return JSON.stringify(handoff);
}
