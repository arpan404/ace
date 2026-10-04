import { emptyTurnDigest, itemMessagePreview, mergeTurnDigests } from "@ace/projection";
import { threadItemText } from "@ace/search/thread-text";
import type {
  ClientMessage,
  CommandId,
  CommandResult,
  DeviceId,
  Item,
  ItemsPage,
  RunId,
  ServerMessage,
  ThreadId,
  ThreadMarkReadCommand,
  ThreadSearchResponse,
  TurnDigest,
  TurnSummary,
} from "@ace/protocol";
import type { SyntheticHistory } from "./long-thread-soak-history.ts";

/*
 * The long-thread reads of `LongThreadSoak` (ADR 0062): turn pages, item windows and pages,
 * search with sparse continuation, catch-up and per-device read cursors, each touching only
 * the turns it needs.
 */

/** The turn after the synthetic ones, which the soak keeps adding items to. */
export interface LiveTurn {
  ordinal: number;
  runId: RunId;
  startSeq: number;
  items: { item: Item; seq: number }[];
  started: boolean;
}

type Located = { item: Item; seq: number; threadId: ThreadId };
/** Turns one search request examines before answering, with a cursor if it found too few. */
const searchTurns = 24;

export class LongThreadReads {
  private history: SyntheticHistory;
  private live: () => LiveTurn;
  private head: () => number;
  private reads = new Map<string, { lastSeenSeq: number; updatedAt: number }>();
  constructor(history: SyntheticHistory, live: () => LiveTurn, head: () => number) {
    this.history = history;
    this.live = live;
    this.head = head;
  }

  private get turns(): number {
    return this.history.shape.turns;
  }
  /** Main-thread items of a turn (the live one included), oldest first. */
  private items(ordinal: number): { item: Item; seq: number }[] {
    if (ordinal > this.turns) return ordinal === this.live().ordinal ? this.live().items : [];
    return this.history.turn(ordinal).items;
  }
  private turnOf(seq: number): number {
    return seq >= this.history.end ? this.live().ordinal : this.history.turnAt(seq);
  }
  /** Up to `limit` items created strictly before `before`, oldest first. */
  private before(before: number, limit: number): { item: Item; seq: number }[] {
    const found: { item: Item; seq: number }[] = [];
    for (let ordinal = this.turnOf(before - 1); ordinal >= 1 && found.length < limit; ordinal--) {
      const items = this.items(ordinal);
      for (let index = items.length - 1; index >= 0 && found.length < limit; index--) {
        const entry = items[index];
        if (entry && entry.seq < before) found.push(entry);
      }
    }
    return found.toReversed();
  }
  /** Up to `limit` items created at or after `from`, oldest first. */
  private from(from: number, limit: number): { item: Item; seq: number }[] {
    const found: { item: Item; seq: number }[] = [];
    const last = this.live().started ? this.live().ordinal : this.turns;
    for (
      let ordinal = Math.max(1, this.turnOf(from));
      ordinal <= last && found.length < limit;
      ordinal++
    )
      for (const entry of this.items(ordinal)) {
        if (found.length >= limit) break;
        if (entry.seq >= from) found.push(entry);
      }
    return found;
  }
  private firstSeq(): number {
    return this.history.firstItemSeq(1);
  }

  page(before: number, limit: number): ItemsPage {
    const items = this.before(before, limit);
    const first = items[0];
    return {
      seq: this.head(),
      threadId: this.history.threadId,
      items: items.map(({ item }) => structuredClone(item)),
      itemSeqs: Object.fromEntries(items.map(({ item, seq }) => [item.id, seq])),
      itemsBefore: first && first.seq > this.firstSeq() ? first.seq : null,
    };
  }

  markRead(
    commandId: CommandId,
    payload: ThreadMarkReadCommand,
    deviceId: DeviceId,
    now: number,
  ): CommandResult {
    if (payload.threadId !== this.history.threadId)
      return { commandId, ok: false, error: "thread_not_found" };
    const key = JSON.stringify([deviceId, payload.threadId]);
    const lastSeenSeq = Math.min(payload.lastSeenSeq, this.head());
    if (lastSeenSeq > (this.reads.get(key)?.lastSeenSeq ?? 0))
      this.reads.set(key, { lastSeenSeq, updatedAt: now });
    return { commandId, ok: true };
  }

  private liveSummary(): TurnSummary | undefined {
    const live = this.live();
    if (!live.started) return undefined;
    const first = live.items[0];
    const last = live.items.at(-1);
    return {
      threadId: this.history.threadId,
      ordinal: live.ordinal,
      startSeq: live.startSeq,
      endSeq: this.head(),
      startedAt: first?.item.createdAt ?? 0,
      status: { state: "working", agents: 1 },
      outcome: "active",
      initiatingMessagePreview: "",
      latestAgentMessagePreview: last?.item.type === "notice" ? last.item.text.slice(0, 1024) : "",
      digest: emptyTurnDigest(),
      subagents: [],
      subagentsTruncated: false,
    };
  }
  private summary(ordinal: number): TurnSummary | undefined {
    if (ordinal <= this.turns) return this.history.summary(ordinal);
    return ordinal === this.live().ordinal ? this.liveSummary() : undefined;
  }
  private lastOrdinal(): number {
    return this.live().started ? this.live().ordinal : this.turns;
  }

  /** Answers a long-thread read for this thread; false for anything else. */
  handle(message: ClientMessage, deviceId: string, send: (reply: ServerMessage) => void): boolean {
    if (!("threadId" in message) || message.threadId !== this.history.threadId) return false;
    switch (message.type) {
      case "turns.page": {
        const last = this.lastOrdinal();
        const from =
          message.after !== undefined
            ? message.after + 1
            : Math.max(1, Math.min(last + 1, message.before ?? last + 1) - message.limit);
        const to = Math.min(last, from + message.limit - 1, (message.before ?? last + 1) - 1);
        const turns: TurnSummary[] = [];
        for (let ordinal = from; ordinal <= to; ordinal++) {
          const summary = this.summary(ordinal);
          if (summary) turns.push(structuredClone(summary));
        }
        const first = turns[0]?.ordinal;
        const end = turns.at(-1)?.ordinal;
        send({
          type: "turns.page",
          requestId: message.requestId,
          threadId: this.history.threadId,
          seq: this.head(),
          indexedSeq: this.head(),
          ready: true,
          turns,
          before: first !== undefined && first > 1 ? first : null,
          after: end !== undefined && end < last ? end : null,
        });
        return true;
      }
      case "items.window": {
        const turnStart =
          message.turnOrdinal === undefined
            ? undefined
            : message.turnOrdinal <= this.turns
              ? this.history.firstItemSeq(message.turnOrdinal)
              : this.items(message.turnOrdinal)[0]?.seq;
        if (message.turnOrdinal !== undefined && turnStart === undefined) {
          send({
            type: "error",
            requestId: message.requestId,
            code: "turn_not_found",
            message: "turn_not_found",
          });
          return true;
        }
        const target =
          this.from(turnStart ?? message.aroundSeq ?? 0, 1)[0] ?? this.before(Infinity, 1)[0];
        const older = target ? this.before(target.seq, message.before) : [];
        const newer = target ? this.from(target.seq + 1, message.after) : [];
        const shown = [...older, ...(target ? [target] : []), ...newer];
        const first = shown[0];
        const last = shown.at(-1);
        send({
          type: "items.window",
          requestId: message.requestId,
          threadId: this.history.threadId,
          seq: this.head(),
          targetSeq: target?.seq ?? null,
          items: shown.map(({ item }) => structuredClone(item)),
          itemSeqs: Object.fromEntries(shown.map(({ item, seq }) => [item.id, seq])),
          itemsBefore: first && first.seq > this.firstSeq() ? first.seq : null,
          itemsAfter: last && this.from(last.seq + 1, 1).length ? last.seq : null,
        });
        return true;
      }
      case "thread.search":
        send(this.search(message));
        return true;
      case "thread.catchUp": {
        const since =
          message.sinceSeq ??
          this.history.firstItemSeq(
            this.firstTurnAfter(message.sinceTime ?? Number.MAX_SAFE_INTEGER),
          );
        const digests: TurnDigest[] = [];
        let completed = 0;
        for (let ordinal = Math.max(1, this.turnOf(since)); ordinal <= this.turns; ordinal++) {
          const summary = this.history.summary(ordinal);
          if (summary.endSeq <= since) continue;
          completed++;
          digests.push(this.history.digest(ordinal));
        }
        const live = this.live();
        const answer = this.history.summary(this.turns).latestAgentMessagePreview;
        const lastLive = live.items.at(-1)?.item;
        send({
          type: "thread.catchUp",
          requestId: message.requestId,
          threadId: this.history.threadId,
          seq: this.head(),
          indexedSeq: this.head(),
          ready: true,
          turnsCompleted: completed,
          status: live.started ? { state: "working", agents: 1 } : { state: "done" },
          digest: mergeTurnDigests(digests),
          latestAgentMessagePreview: lastLive ? itemMessagePreview(lastLive) || answer : answer,
        });
        return true;
      }
      case "thread.readState": {
        const state = this.reads.get(JSON.stringify([deviceId, message.threadId]));
        send({
          type: "thread.readState",
          requestId: message.requestId,
          threadId: this.history.threadId,
          lastSeenSeq: state?.lastSeenSeq ?? 0,
          updatedAt: state?.updatedAt ?? null,
        });
        return true;
      }
      default:
        return false;
    }
  }

  private firstTurnAfter(time: number): number {
    for (let ordinal = 1; ordinal <= this.turns; ordinal++)
      if (this.history.summary(ordinal).startedAt > time) return ordinal;
    return this.turns;
  }

  private search(message: Extract<ClientMessage, { type: "thread.search" }>): ThreadSearchResponse {
    const signature = fingerprint([message.text, message.scope, message.filter ?? ""]);
    const [turnText, indexText, sign] = message.cursor?.split(":") ?? [];
    const resume =
      sign === signature
        ? { turn: Number(turnText), index: Number(indexText) }
        : { turn: 1, index: 0 };
    const query = message.text.toLocaleLowerCase();
    const hits: ThreadSearchResponse["hits"] = [];
    const last = this.lastOrdinal();
    let cursor: string | null = null;
    for (let ordinal = resume.turn, examined = 0; ordinal <= last; ordinal++, examined++) {
      if (examined >= searchTurns) {
        cursor = `${ordinal}:0:${signature}`;
        break;
      }
      const entries: Located[] = [];
      for (const { item, seq } of this.items(ordinal))
        entries.push({ item, seq, threadId: this.history.threadId });
      if (message.scope === "tree" && ordinal <= this.turns)
        for (const child of this.history.turn(ordinal).childItems) entries.push(child);
      entries.sort((a, b) => a.seq - b.seq);
      const outputs = ordinal <= this.turns ? this.history.turn(ordinal).outputs : undefined;
      const start = ordinal === resume.turn ? resume.index : 0;
      for (let index = start; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        const snippet = match(entry.item, query, message.filter, outputs?.get(entry.item.id));
        if (!snippet) continue;
        hits.push({
          threadId: entry.threadId,
          itemId: entry.item.id,
          seq: entry.seq,
          turnOrdinal: ordinal,
          snippet,
        });
        if (hits.length >= message.limit) {
          cursor = `${ordinal}:${index + 1}:${signature}`;
          break;
        }
      }
      if (cursor) break;
    }
    return {
      type: "thread.search",
      requestId: message.requestId,
      threadId: this.history.threadId,
      hits,
      cursor,
      indexedSeq: this.head(),
      headSeq: this.head(),
      pending: 0,
      ready: true,
    };
  }
}

/**
 * The item's first text that holds the query, as a snippet with the match marked. A command's
 * output is searched whole, as the daemon indexes its stream, not just the tail the item keeps.
 */
function match(
  item: Item,
  query: string,
  filter: "messages" | "tool_output" | "commands" | "files" | "errors" | undefined,
  output: string | undefined,
): ThreadSearchResponse["hits"][number]["snippet"] | undefined {
  for (const segment of threadItemText(item)) {
    if (filter !== undefined && segment.category !== filter) continue;
    const body = segment.name === "output" && output !== undefined ? output : segment.text;
    const at = body.toLocaleLowerCase().indexOf(query);
    if (at < 0) continue;
    const start = Math.max(0, at - 96);
    const text = body.slice(start, start + 320);
    return {
      text,
      highlights: [{ start: at - start, end: Math.min(text.length, at - start + query.length) }],
    };
  }
  return undefined;
}

/** Binds a cursor to its query, scope and filter. */
function fingerprint(fields: readonly string[]): string {
  const text = JSON.stringify(fields);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
  return hash.toString(16);
}
