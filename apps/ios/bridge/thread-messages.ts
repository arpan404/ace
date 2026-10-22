import type { ThreadSource } from "@ace/client";
import type { Item } from "@ace/protocol";
import {
  bubbleContent,
  bubbleSegments,
  describeProviderError,
  eventCounts,
  eventFollowsOrder,
  eventView,
  isLimitError,
  isLongMessage,
  mayBeSystemInput,
  messageOrigin,
  referenceSegments,
  thoughtLabel,
  thoughtMs,
  type EventView,
} from "@ace/ui-core";
import { preview } from "./presentation.ts";

/*
 * What the phone's message rows show beyond an item's text, from the same `@ace/ui-core`
 * decisions the web draws: the person's bubble (its words, code runs, mention chips, the long
 * fold, how it was sent), an event's one row (`eventView`), a thought's header and whether an
 * answer still streams. Swift draws these as given. Display text is bounded.
 */

const bubbleChars = 16_384;

/** How a message reached the agent, when that isn't simply typed and sent. */
const origins = new Set(["steer", "queue"]);

/** The person's bubble: its runs of words, code and mentions, bounded, and whether it folds. */
export function bubbleOf(item: Item) {
  if (item.type !== "message" || item.role !== "user") return null;
  const content = bubbleContent(item.parts);
  const mentions = content.parts.some((part) => part.type === "mention");
  const runs = mentions
    ? referenceSegments(content.parts).map((segment) =>
        segment.kind === "text"
          ? { kind: "text", text: segment.text, mention: "" }
          : { kind: "mention", text: segment.name, mention: segment.mention },
      )
    : bubbleSegments(content.text).map((segment) => ({
        kind: segment.kind,
        text: segment.text,
        mention: "",
      }));
  let room = bubbleChars;
  const segments = runs.flatMap((segment) => {
    if (room <= 0) return [];
    const text = segment.text.slice(0, room);
    room -= text.length;
    return [{ ...segment, text }];
  });
  const origin = messageOrigin(item)?.kind ?? "";
  return {
    segments,
    readable: content.readable,
    long: isLongMessage(content.text),
    origin: origins.has(origin) ? origin : "",
  };
}

/** A thought's header: "Thinking…", "Thought for 12s", or "Thought" when the time is unknown. */
export function thoughtOf(store: ThreadSource, item: Item): string | null {
  if (item.type !== "reasoning") return null;
  const run = item.runId ? store.run(item.runId) : undefined;
  // A thought whose turn is over is finished, whatever its stream last said.
  const done = item.complete || (run !== undefined && run.state !== "active");
  return thoughtLabel(done, thoughtMs(store, item.id));
}

/** An answer still arriving: incomplete while its turn runs. */
export function streamingOf(store: ThreadSource, item: Item | undefined): boolean {
  if (!item || item.complete) return false;
  const run = item.runId ? store.run(item.runId) : undefined;
  return run?.state === "active";
}

const icons: Partial<Record<EventView["kind"], string>> = {
  quiet: "info",
  refusal: "robot",
  notSent: "warning",
};

/** One event row, flattened for Swift: its glyph, words, what opens from it and ×N. */
function flatten(view: EventView) {
  const row = {
    kind: view.kind,
    icon: icons[view.kind] ?? "",
    provider: "",
    text: "",
    note: "",
    detail: "",
    mono: false,
    at: 0,
    count: 1,
  };
  switch (view.kind) {
    case "event": {
      const shown = view.summary ?? view.received;
      return {
        ...row,
        icon: view.line.icon,
        provider: view.line.provider ?? "",
        text: preview(view.line.text, 256),
        note: preview(view.line.note ?? "", 512),
        detail: preview(shown ?? "", 4096),
        mono: !view.summary && !!view.received,
        at: view.at,
      };
    }
    case "system":
      return { ...row, icon: view.icon, text: preview(view.text, 512), at: view.at };
    case "refusal":
      return {
        ...row,
        text: preview(view.refusal.label, 256),
        note: preview(view.refusal.reason ?? "", 512),
        count: view.count,
      };
    case "error": {
      const shown = describeProviderError(view.error);
      const raw = shown.raw && shown.raw !== shown.title && shown.raw !== shown.message;
      return {
        ...row,
        // A limit lifts on its own: a quiet hourglass, not an alarm.
        icon: isLimitError(shown) ? "limit" : "failed",
        text: preview(shown.title, 256),
        note: preview(shown.message ?? "", 512),
        detail: raw ? preview(shown.raw ?? "", 4096) : "",
        count: view.count,
      };
    }
    case "notSent":
      return {
        ...row,
        text: "Not sent",
        note: preview(view.notice.detail ?? view.notice.text, 512),
      };
    case "notice":
      return { ...row, icon: view.level, text: preview(view.text, 4096) };
    case "quiet":
      return { ...row, text: preview(view.text, 4096) };
    default:
      return row;
  }
}

/** Whether a block's item is drawn as an event: everything but the person's own bubble. */
function isEvent(kind: string, item: Item | undefined): boolean {
  return kind === "event" || kind === "item" || (kind === "user" && mayBeSystemInput(item));
}

/** An event block's row, as the web's `EventBlock` decides it; null for the person's bubble. */
export function eventRow(store: ThreadSource, kind: string, itemId: string) {
  const item = store.item(itemId);
  if (!isEvent(kind, item)) return null;
  return flatten(eventView(item, eventCounts(store, itemId), store.thread?.provider));
}

/** Whether a block's row reads the rows around it (×N, repeats), so it follows the order. */
export function eventFollows(store: ThreadSource, kind: string, itemId: string): boolean {
  const item = store.item(itemId);
  return isEvent(kind, item) && eventFollowsOrder(item);
}

/** A one-item block's message fields: an answer's streaming, or an event's row. */
export function messageBlock(store: ThreadSource, kind: string, itemId: string | undefined) {
  if (itemId === undefined) return {};
  if (kind === "message") return { streaming: streamingOf(store, store.item(itemId)) };
  return { event: eventRow(store, kind, itemId) };
}

/**
 * Thought headers for a settled turn's steps as the daemon read them: a thought ends where the
 * turn's next item began, else where its turn ended.
 */
export function turnThoughts(store: ThreadSource, items: readonly Item[]) {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  const reader = {
    order: items.map((item) => item.id),
    item: (id: string) => byId.get(id),
    run: (id: string) => store.run(id),
  };
  return (item: Item): string | null =>
    item.type === "reasoning" ? thoughtLabel(true, thoughtMs(reader, item.id)) : null;
}
