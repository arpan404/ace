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
  isSentByAgent,
  looksLikeMarkdown,
  sentByLine,
  sentFold,
  mayBeSystemInput,
  messageOrigin,
  personFold,
  promptText,
  referenceSegments,
  systemInput,
  thoughtLabel,
  thoughtMs,
  type BubbleFold,
  type EventView,
  withHardBreaks,
} from "@ace/ui-core";
import { preview } from "./presentation.ts";

/*
 * What the phone's message rows show beyond an item's text, from the same `@ace/ui-core`
 * decisions the web draws: the person's bubble (its words, code runs, mention chips, the long
 * fold, how it was sent, the passages it replies to), an event's one row (`eventView`), a thought's header and whether an
 * answer still streams. Swift draws these as given. Display text is bounded.
 */

const bubbleChars = 16_384;

/** How a message reached the agent, when that isn't simply typed and sent. */
const origins = new Set(["steer", "queue"]);

/** Runs of words and code within the bubble's bound. */
function bounded<T extends { text: string }>(runs: readonly T[]): T[] {
  let room = bubbleChars;
  return runs.flatMap((segment) => {
    if (room <= 0) return [];
    // Native repair: a cut never leaves half a pair, and ill-formed text never reaches JSON.
    const text = preview(segment.text, room);
    room -= text.length;
    return [{ ...segment, text }];
  });
}

/**
 * The markdown a bubble renders, as the web's bubble decides it: text the writer plainly meant as
 * markdown, every line break kept, bounded; empty for text drawn as runs.
 */
function markdownOf(text: string): string {
  return looksLikeMarkdown(text) ? preview(withHardBreaks(text), bubbleChars) : "";
}

/**
 * The words as written, for Copy, Select text and Share: bounded as the bubble is, and whether
 * the bound cut them (the phone then reads them whole with `native.message`'s `bubble`).
 */
function wordsOf(text: string, stored = false) {
  return { source: preview(text, bubbleChars), cut: stored || text.length > bubbleChars };
}

/** Whether the daemon keeps more of the message than its item carries (`native.message` reads it). */
function storedLonger(item: Item | undefined): boolean {
  return (
    item?.type === "message" &&
    item.parts.some(
      (part) =>
        part.type === "text" &&
        part.source !== undefined &&
        part.source.bytes > part.text.length * 2,
    )
  );
}

/**
 * A message's bubble words in full: a brief another thread sent without ace's frame, else the
 * person's words without the passages they reply to. Mentions read as their tokens.
 */
export function bubbleWords(item: Item): string {
  if (item.type !== "message") return "";
  const input = systemInput(item);
  if (input && isSentByAgent(input)) return promptText(input);
  return bubbleContent(item.parts).text;
}

/**
 * Plain words drawn as the person's bubble (a subagent's prompt from its parent, a brief another
 * thread sent): the same runs of words and code, bound as a message the person wrote. `fold` is
 * when it folds and how many lines it then shows; a brief folds sooner than the person's words.
 */
export function textBubble(text: string, fold: BubbleFold = personFold, stored = false) {
  return {
    segments: bounded(
      bubbleSegments(text).map((segment) => ({
        kind: segment.kind,
        text: segment.text,
        mention: "",
      })),
    ),
    markdown: markdownOf(text),
    ...wordsOf(text, stored),
    readable: text.trim().length > 0,
    long: isLongMessage(text, fold),
    fold: fold.shown,
    origin: "",
  };
}

/**
 * The person's bubble: its runs of words, code and mentions, bounded, the markdown it renders
 * instead when it reads as markdown, and whether and where it folds.
 */
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
  const segments = bounded(runs);
  const origin = messageOrigin(item)?.kind ?? "";
  return {
    segments,
    // What it replies to, drawn above the words; each passage bounded as the bubble is.
    quotes: (content.quotes ?? []).map((quote) => ({ text: preview(quote.text, 1024) })),
    // Mentions draw as chips, so a message with any stays runs, as on the web.
    markdown: mentions ? "" : markdownOf(content.text),
    // A message with mentions copies its runs, the chips by name; its words hold their tokens.
    ...(mentions ? { source: "", cut: false } : wordsOf(content.text, storedLonger(item))),
    readable: content.readable,
    long: isLongMessage(content.text, personFold),
    fold: personFold.shown,
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
function flatten(view: EventView, item: Item | undefined) {
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
    /** A stale Git lock an earlier daemon left stopped it: Clear stale lock is offered. */
    fenced: false,
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
      return {
        ...row,
        icon: view.icon,
        text: preview(view.text, 512),
        // A compaction's summary opens from its row, as on the web.
        detail: preview(view.summary ?? "", 4096),
        at: view.at,
      };
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
        fenced: view.notice.details?.code === "git_quarantined",
      };
    case "notice":
      return { ...row, icon: view.level, text: preview(view.text, 4096) };
    case "quiet":
      return { ...row, text: preview(view.text, 4096) };
    case "sent":
      // The person's bubble of the brief, under a line naming the thread that sent it. Swift
      // names a local sender by the thread list's current title, as the web does.
      return {
        ...row,
        provider: view.sent.provider ?? "",
        text: sentByLine(view.sent),
        detail: preview(view.text, 4096),
        sent: {
          /** Empty when ace doesn't know the sender: the line then opens nothing. */
          threadId: view.sent.threadId ?? "",
          /** The sender's machine when it isn't this one; empty for this machine. */
          hostId: view.sent.host?.id ?? "",
          line: preview(sentByLine(view.sent), 512),
          bubble: textBubble(view.text, sentFold, storedLonger(item)),
        },
      };
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
  return flatten(
    eventView(item, eventCounts(store, itemId), store.thread?.provider, store.thread),
    item,
  );
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
 * How long each thought of a settled turn took, from its steps as the daemon read them: a thought
 * ends where the turn's next item began, else where its turn ended.
 */
export function turnThoughtMs(store: ThreadSource, items: readonly Item[]) {
  const byId = new Map<string, Item>(items.map((item) => [item.id, item]));
  const reader = {
    order: items.map((item) => item.id),
    item: (id: string) => byId.get(id),
    run: (id: string) => store.run(id),
  };
  return (id: string): number | undefined => thoughtMs(reader, id);
}

/** Thought headers for a settled turn's steps, timed by `turnThoughtMs`. */
export function turnThoughts(took: (id: string) => number | undefined) {
  return (item: Item): string | null =>
    item.type === "reasoning" ? thoughtLabel(true, took(item.id)) : null;
}
