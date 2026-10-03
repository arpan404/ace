import { z } from "zod";
import { ThreadId, ProviderKind, type Item, type PortableHandoff } from "@ace/protocol";
import { renderHandoff, selectHandoff, handoffBytes } from "@ace/handoff";

const Source = z.object({
  threadId: ThreadId,
  provider: ProviderKind,
  backend: z.string().min(1).max(256).optional(),
  throughSeq: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  totalItems: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export interface PortableSource {
  threadId: string;
  provider: ProviderKind;
  backend?: string | undefined;
  /** Frozen ace event cutoff and indexed inventory, supplied by the storage owner. */
  throughSeq: number;
  totalItems: number;
}
const Options = z.object({
  maxBytes: z.number().int().min(1024).max(262144),
  maxItems: z.number().int().min(1).max(200),
  historyTruncated: z.boolean(),
});

/** Cursor's portable fork facade uses the same budget, citations and selection as engine transitions. */
export function portableContext(
  source: PortableSource,
  history: Iterable<Item>,
  options: { maxBytes: number; maxItems: number; historyTruncated: boolean },
): {
  text: string;
  bytes: number;
  truncated: boolean;
  source: PortableSource;
  handoff: PortableHandoff;
} {
  const origin = Source.parse(source);
  const limits = Options.parse(options);
  const items: Item[] = [];
  let unseen = limits.historyTruncated;
  // Inspect at most maxItems+1 entries; never buffer an unbounded SDK transcript.
  for (const item of history) {
    if (items.length === limits.maxItems) {
      unseen = true;
      break;
    }
    items.push(item);
  }
  const handoff = selectHandoff(
    {
      threadId: origin.threadId,
      throughSeq: origin.throughSeq,
      totalItems: origin.totalItems,
      items,
      origin: { provider: origin.provider, ...(origin.backend ? { backend: origin.backend } : {}) },
    },
    limits.maxBytes,
  );
  const truncated =
    unseen ||
    handoff.omittedItems > 0 ||
    items.some((item) =>
      item.type === "message"
        ? item.parts.some(
            (part) => part.type !== "text" || part.source !== undefined || part.text.length > 8000,
          )
        : item.type === "tool_call" ||
          item.type === "compaction" ||
          item.type === "artifact" ||
          ((item.type === "reasoning" || item.type === "notice") &&
            (item.source !== undefined || item.text.length > 8000)),
    );
  return {
    // Engine transitions persist the manifest; adapters can request its rendered prompt lazily.
    get text() {
      return renderHandoff(handoff);
    },
    get bytes() {
      return handoffBytes(handoff);
    },
    truncated,
    source: origin,
    handoff,
  };
}
