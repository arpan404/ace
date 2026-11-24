import {
  spadeMayFold,
  type SpadeChatItem,
  type SpadeDocCard,
  type SpadeGroupBot,
  type SpadeGroupRow,
  type SpadeQuote,
} from "@ace/ui-core/spade-chat";

/*
 * Pure presentation grouping for Spade chats and clubs:
 * - Coalesces the `<msg>` segments of a single reply turn by one sender into ONE soft block
 *   holding its paragraphs, while keeping distinct-quote splits and `<doc>` cards separate.
 * - Keeps separate messages over time as stacked blocks with messenger-style joined corners.
 * - In clubs, converts bot-to-bot relay lines ("Spade asked Flights") into an inline header
 *   qualifier ("Flights · answering Spade") on the relayed reply, or drops them if unmatched.
 */

export type BubbleStackPosition = "single" | "first" | "middle" | "last";

export function stackPosition(hasBefore: boolean, hasAfter: boolean): BubbleStackPosition {
  if (hasBefore && hasAfter) return "middle";
  if (hasBefore) return "last";
  if (hasAfter) return "first";
  return "single";
}

/** Short one-liners use tighter padding (10px 14px); multi-line/quoted bubbles use 14px 16px. */
export function isLongBubble(text: string, hasQuote = false, hasExtra = false): boolean {
  return hasQuote || hasExtra || text.includes("\n") || text.length > 90;
}

export interface CoalescedRunItem {
  item: SpadeChatItem;
  when: string | undefined;
  /** All message ids merged into this block, for quote jump-to-original and reactions. */
  ids: string[];
  stack: BubbleStackPosition;
}

const baseKey = (key: string) => key.replace(/:\d+$/, "");

const isStackableRunItem = (item: SpadeChatItem): boolean => {
  if (item.kind === "person") return true;
  if (item.kind === "other") return !item.contract;
  if (item.kind === "bot") return Boolean(item.text || item.end || item.doc);
  return false;
};

/**
 * Merge same-turn segments of one reply into a single block while keeping separate turns
 * stacked tightly with messenger-style joined corners.
 */
export function coalesceRunItems(
  items: readonly SpadeChatItem[],
  whens: readonly (string | undefined)[],
): CoalescedRunItem[] {
  const quotesByTurn = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.kind === "bot" && item.turn && item.quote) {
      let set = quotesByTurn.get(item.turn);
      if (!set) {
        set = new Set();
        quotesByTurn.set(item.turn, set);
      }
      set.add(item.quote.id);
    }
  }

  const out: CoalescedRunItem[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item) continue;
    const when = whens[index];
    const prev = out.at(-1);

    if (
      item.kind === "bot" &&
      prev?.item.kind === "bot" &&
      item.turn !== undefined &&
      prev.item.turn === item.turn &&
      !prev.item.doc &&
      !item.doc &&
      prev.item.images.length === 0 &&
      prev.item.documents.length === 0 &&
      !prev.item.files &&
      !prev.item.end &&
      prev.item.text.length > 0 &&
      (item.text.length > 0 || item.end !== undefined) &&
      !item.quote &&
      !(prev.item.quote && (quotesByTurn.get(item.turn)?.size ?? 0) >= 2)
    ) {
      const mergedText =
        prev.item.text && item.text
          ? `${prev.item.text}\n\n${item.text}`
          : prev.item.text || item.text;
      const live = prev.item.live || item.live;
      const fold = !live && (prev.item.fold || item.fold || spadeMayFold(mergedText));
      const files = item.files ? [...(prev.item.files ?? []), ...item.files] : prev.item.files;
      prev.item = {
        ...prev.item,
        text: mergedText,
        live,
        images: [...prev.item.images, ...item.images],
        documents: [...prev.item.documents, ...item.documents],
        ...(files ? { files } : {}),
        ...(item.end ? { end: item.end } : {}),
        ...(item.failure ? { failure: item.failure } : {}),
        ...(item.keep ? { keep: item.keep } : {}),
        ...(item.repliedTo ? { repliedTo: item.repliedTo } : {}),
        ...(item.fromChat && !prev.item.fromChat ? { fromChat: item.fromChat } : {}),
        ...(fold ? { fold: true as const } : {}),
      };
      if (item.id) prev.ids.push(item.id);
      if (when !== undefined) prev.when = when;
      continue;
    }

    if (
      item.kind === "other" &&
      prev?.item.kind === "other" &&
      !item.contract &&
      !prev.item.contract &&
      !item.doc &&
      !prev.item.doc &&
      item.agent.id === prev.item.agent.id &&
      baseKey(item.key) === baseKey(prev.item.key)
    ) {
      const mergedText =
        prev.item.text && item.text
          ? `${prev.item.text}\n\n${item.text}`
          : prev.item.text || item.text;
      const fold = prev.item.fold || item.fold || spadeMayFold(mergedText);
      prev.item = {
        ...prev.item,
        text: mergedText,
        ...(fold ? { fold: true as const } : {}),
      };
      if (item.id) prev.ids.push(item.id);
      if (when !== undefined) prev.when = when;
      continue;
    }

    const id = "id" in item && typeof item.id === "string" ? item.id : undefined;
    out.push({
      item,
      when,
      ids: id ? [id] : [],
      stack: "single",
    });
  }

  for (let index = 0; index < out.length; index++) {
    const entry = out[index];
    if (!entry || !isStackableRunItem(entry.item)) continue;
    const before = out[index - 1];
    const after = out[index + 1];
    entry.stack = stackPosition(
      before !== undefined && isStackableRunItem(before.item),
      after !== undefined && isStackableRunItem(after.item),
    );
  }

  return out;
}

export interface ClubMemberMessage {
  key: string;
  bot: SpadeGroupBot;
  text: string;
  ids: string[];
  quote?: SpadeQuote | undefined;
  doc?: SpadeDocCard | undefined;
  fold?: true | undefined;
  run?: string | undefined;
  stack: BubbleStackPosition;
}

export type ClubBlock =
  | {
      kind: "person";
      key: string;
      items: { row: Extract<SpadeGroupRow, { kind: "person" }>; stack: BubbleStackPosition }[];
    }
  | {
      kind: "member";
      key: string;
      bot: SpadeGroupBot;
      /** Set when preceded by a bot-to-bot handoff ("Spade asked Flights"). */
      relayedBy?: string | undefined;
      messages: ClubMemberMessage[];
    }
  | {
      kind: "line";
      key: string;
      text: string;
    };

const sameBot = (a: SpadeGroupBot, b: SpadeGroupBot) =>
  a.id === b.id && (a.machine ?? null) === (b.machine ?? null);

const relayPattern = /^(.+) asked (.+)$/;

/**
 * Group club transcript rows into sender runs with one header per run, coalescing one reply turn's
 * messages into one soft block and turning bot-to-bot relay lines into inline header qualifiers.
 */
export function groupClubRows(rows: readonly SpadeGroupRow[]): ClubBlock[] {
  const quotesByRun = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.kind !== "member" || !row.quote) continue;
    const scope = `${row.bot.id}:${row.bot.machine ?? ""}:${row.run ?? baseKey(row.key)}`;
    let set = quotesByRun.get(scope);
    if (!set) {
      set = new Set();
      quotesByRun.set(scope, set);
    }
    set.add(row.quote.id);
  }

  const blocks: ClubBlock[] = [];
  let pendingRelay: { by: string; to: string } | undefined;

  for (const row of rows) {
    if (row.kind === "line") {
      const match = relayPattern.exec(row.text);
      if (match?.[1] && match[2]) {
        pendingRelay = { by: match[1], to: match[2] };
        continue;
      }
      pendingRelay = undefined;
      blocks.push({ kind: "line", key: row.key, text: row.text });
      continue;
    }

    if (row.kind === "person") {
      pendingRelay = undefined;
      const last = blocks.at(-1);
      if (last?.kind === "person") {
        last.items.push({ row, stack: "single" });
      } else {
        blocks.push({ kind: "person", key: row.key, items: [{ row, stack: "single" }] });
      }
      continue;
    }

    const relayedBy = pendingRelay?.to === row.bot.name ? pendingRelay.by : undefined;
    pendingRelay = undefined;

    const last = blocks.at(-1);
    if (last?.kind === "member" && sameBot(last.bot, row.bot) && !relayedBy) {
      const prev = last.messages.at(-1);
      const sameTurn =
        prev !== undefined &&
        (row.run !== undefined && prev.run !== undefined
          ? prev.run === row.run
          : row.run === undefined &&
            prev.run === undefined &&
            baseKey(prev.key) === baseKey(row.key));
      const scope = `${row.bot.id}:${row.bot.machine ?? ""}:${row.run ?? baseKey(row.key)}`;
      const multiQuote = (quotesByRun.get(scope)?.size ?? 0) >= 2;

      if (
        prev &&
        sameTurn &&
        !prev.doc &&
        !row.doc &&
        prev.text.length > 0 &&
        row.text.length > 0 &&
        !row.quote &&
        !(prev.quote && multiQuote)
      ) {
        prev.text = `${prev.text}\n\n${row.text}`;
        if (row.id) prev.ids.push(row.id);
        if (row.fold || spadeMayFold(prev.text)) prev.fold = true;
        continue;
      }

      last.messages.push({
        key: row.key,
        bot: row.bot,
        text: row.text,
        ids: row.id ? [row.id] : [],
        quote: row.quote,
        doc: row.doc,
        fold: row.fold,
        run: row.run,
        stack: "single",
      });
      continue;
    }

    blocks.push({
      kind: "member",
      key: row.key,
      bot: row.bot,
      ...(relayedBy ? { relayedBy } : {}),
      messages: [
        {
          key: row.key,
          bot: row.bot,
          text: row.text,
          ids: row.id ? [row.id] : [],
          quote: row.quote,
          doc: row.doc,
          fold: row.fold,
          run: row.run,
          stack: "single",
        },
      ],
    });
  }

  for (const block of blocks) {
    if (block.kind === "person") {
      for (let i = 0; i < block.items.length; i++) {
        const entry = block.items[i];
        if (!entry) continue;
        entry.stack = stackPosition(i > 0, i < block.items.length - 1);
      }
    } else if (block.kind === "member") {
      for (let i = 0; i < block.messages.length; i++) {
        const message = block.messages[i];
        if (!message || message.doc) continue;
        const before = block.messages[i - 1];
        const after = block.messages[i + 1];
        message.stack = stackPosition(
          before !== undefined && !before.doc,
          after !== undefined && !after.doc,
        );
      }
    }
  }

  return blocks;
}

/** Extract the stored event sequence number from a message id like `m12` or `m5.2`. */
export function seqOfMessageId(id: string | undefined): number | undefined {
  if (!id) return undefined;
  const match = /^m(\d+)/.exec(id);
  return match?.[1] ? Number(match[1]) : undefined;
}
