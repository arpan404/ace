import {
  PortableHandoff,
  type HandoffModel,
  type Item,
  type ProviderKind,
  type ThreadId,
} from "@ace/protocol";
import { withoutHandoffEnvelope } from "./envelope.ts";
import { handoffFooter, renderExcerpt, renderHeader, utf8Bytes } from "./render.ts";

export interface HandoffSource {
  threadId: ThreadId;
  throughSeq: number;
  totalItems: number;
  /** Bounded previews of the newest items, in chronological order, from the storage owner. */
  items: readonly Item[];
  /**
   * The thread's opening ask when it is older than `items`: what the work is for. Without it
   * the oldest person message in `items` stands in.
   */
  opening?: Item | undefined;
  origin?: PortableHandoff["origin"];
  /** The recipient resumes its own session, which holds everything up to this cutoff. */
  since?: number | undefined;
}

const maxExcerpt = 8192;
const maxSources = 8;

/** ace's own inputs that say nothing about the work: restarts, resumes and earlier handoffs. */
const quietOrigins = new Set(["handoff", "restart", "limit_resume"]);

function originKind(item: Item): string | undefined {
  return item.type === "message" ? item.origin?.kind : undefined;
}

/** A message the person wrote, as opposed to ace's or the agent's. */
function personMessage(item: Item): boolean {
  if (item.type !== "message" || item.role !== "user") return false;
  const kind = originKind(item);
  return kind === undefined
    ? !item.synthetic
    : kind === "person" || kind === "queue" || kind === "steer";
}

/** The model that wrote an item, when the run recorded one. */
function author(item: Item): HandoffModel | undefined {
  const selection = item.executionSource?.selection;
  if (!selection) return undefined;
  return { provider: selection.provider, ...(selection.model ? { model: selection.model } : {}) };
}

function attribution(item: Item): string {
  const by = author(item);
  return by ? ` (${by.model ? `${by.model} on ${by.provider}` : by.provider})` : "";
}

/** One excerpt's text, or undefined when the item carries nothing the next agent can use. */
function excerpt(item: Item): string | undefined {
  if (!item.complete) return undefined;
  switch (item.type) {
    case "message": {
      if (item.role === "user" && quietOrigins.has(originKind(item) ?? "")) return undefined;
      let text = item.role === "user" ? "user: " : `assistant${attribution(item)}: `;
      const start = text.length;
      for (const [index, part] of item.parts.entries()) {
        const available = maxExcerpt - text.length;
        if (available <= 0) break;
        let value =
          part.type === "text"
            ? part.text
            : part.type === "mention"
              ? `[${part.kind}: ${part.name}]`
              : part.type === "file"
                ? `[file: ${part.path}]`
                : `[image: ${part.mimeType}]`;
        // A message sent right after an earlier handoff can still carry its block.
        if (index === 0 && part.type === "text") value = withoutHandoffEnvelope(value) ?? value;
        if (text.length > start && value) text += "\n";
        text += value.slice(0, available);
      }
      return text.length > start && text.slice(start).trim()
        ? text.slice(0, maxExcerpt)
        : undefined;
    }
    case "tool_call":
      return `tool${attribution(item)}: ${item.call.title.slice(0, 2000)} (${item.call.status})`;
    case "notice":
      return item.level === "info" ? undefined : `${item.level}: ${item.text}`.slice(0, maxExcerpt);
    case "html":
      return `visualization: ${item.visualization.title}`.slice(0, maxExcerpt);
    case "image":
      return `image: ${item.image.alt}${item.image.caption ? ` (${item.image.caption})` : ""}`.slice(
        0,
        maxExcerpt,
      );
    case "artifact":
      return `artifact: ${item.path.slice(0, 4000)} (${item.mimeType.slice(0, 128)})`;
    case "delegation.started":
      return `delegated to ${item.provider}: ${item.title} (thread ${item.childThreadId}, ${item.status.state})`.slice(
        0,
        maxExcerpt,
      );
    case "delegation.settled":
      return `delegation results: ${JSON.stringify(item.results)}`.slice(0, maxExcerpt);
    // The other provider's private thinking and compaction markers stay behind handoff_read.
    case "reasoning":
    case "compaction":
      return undefined;
  }
}

/**
 * The order excerpts are offered to the budget: the latest ask, the latest answer, the opening
 * ask, then everything else newest first. Indexes into `candidates`.
 */
function priority(candidates: readonly Item[], opening: number | undefined): number[] {
  const order = new Set<number>();
  const take = (index: number | undefined) => {
    if (index !== undefined && index >= 0) order.add(index);
  };
  take(candidates.findLastIndex(personMessage));
  take(candidates.findLastIndex((item) => item.type === "message" && item.role === "assistant"));
  take(opening);
  for (let index = candidates.length - 1; index >= 0; index--) take(index);
  return [...order];
}

/** Distinct models whose work is in `items`, oldest first, plus `fallback` when none ran. */
export function handoffSources(
  items: Iterable<Item>,
  fallback?: { provider: ProviderKind; model?: string | undefined },
): HandoffModel[] {
  const seen = new Map<string, HandoffModel>();
  for (const item of items) {
    const by = author(item);
    if (!by || seen.size >= maxSources) continue;
    const key = `${by.provider}\u0000${by.model ?? ""}`;
    if (!seen.has(key)) seen.set(key, by);
  }
  if (!seen.size && fallback)
    return [{ provider: fallback.provider, ...(fallback.model ? { model: fallback.model } : {}) }];
  return [...seen.values()];
}

/**
 * Cold, bounded selection: at most 201 items in, never more than `budgetBytes` of rendered
 * text out. No I/O, clock, tokenizer assumptions or provider checks.
 */
export function selectHandoff(source: HandoffSource, budgetBytes: number): PortableHandoff {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1024 || budgetBytes > 262144)
    throw new Error("Handoff budget must be 1024..262144 bytes");
  if (source.items.length > 200 || source.totalItems < source.items.length)
    throw new Error("Invalid bounded handoff inventory");
  const opened = source.opening && !source.items.some((item) => item.id === source.opening?.id);
  const candidates = opened && source.opening ? [source.opening, ...source.items] : source.items;
  const texts = candidates.map(excerpt);
  const sources = handoffSources(candidates.filter((_, index) => texts[index] !== undefined));
  const result = PortableHandoff.parse({
    version: 1,
    sourceThreadId: source.threadId,
    ...(source.origin ? { origin: source.origin } : {}),
    throughSeq: source.throughSeq,
    lossy: true,
    policy: "conversation-first",
    ...(sources.length ? { sources } : {}),
    ...(source.since === undefined ? {} : { since: source.since }),
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
  // The header is costed at the full omitted count; its digits only shrink from here.
  let bytes = utf8Bytes(renderHeader(result)) + utf8Bytes(handoffFooter);
  if (bytes > budgetBytes) throw new Error("Handoff manifest exceeds budget");
  const firstPerson = candidates.findIndex(personMessage);
  const chosen: number[] = [];
  for (const index of priority(candidates, firstPerson < 0 ? undefined : firstPerson)) {
    const item = candidates[index];
    const text = texts[index];
    if (!item || text === undefined) continue;
    const entry = { citation: { threadId: source.threadId, itemId: item.id }, text };
    const cost = utf8Bytes(renderExcerpt(entry));
    if (bytes + cost > budgetBytes) continue;
    bytes += cost;
    chosen.push(index);
  }
  chosen.sort((a, b) => a - b);
  for (const index of chosen) {
    const item = candidates[index];
    const text = texts[index];
    if (!item || text === undefined) continue;
    result.excerpts.push({ citation: { threadId: source.threadId, itemId: item.id }, text });
  }
  result.omittedItems = Math.max(0, source.totalItems - result.excerpts.length);
  return result;
}
