import { OutputLineDroppedError } from "@ace/provider-kit/process";
import { maxProviderPayloadBytes } from "@ace/provider-kit/payload";
import { list, obj, str, type Obj } from "./native.ts";

/**
 * Codex thread history in bounded pieces (#693). One `thread/resume` or `thread/read` with turns
 * returns a thread's whole history as one JSON-RPC line, so its size grows with the thread and a
 * long thread outgrows the frame bound and can never be reopened. Opening and recovery need only
 * a thread's current state, which lives in its newest turns: an active turn is always the latest,
 * and ace already holds everything older in its own store. So only the newest turns are read,
 * newest page first, and recorded as notes that each fit the frame bound. The work is the same
 * for a thread of ten turns or ten thousand.
 */
const historyPageTurns = 4;
/** Room under the frame bound for the note envelope and credential redaction. */
const noteBudget = maxProviderPayloadBytes - 64 * 1024;

type Request = (method: string, params: unknown) => Promise<unknown>;

type OmittedTurn = {
  event: "thread-history-omitted";
  turnId: string;
  item: string;
  bytes: number;
  reason: string;
  bytesAtLeast: true;
};
type ItemsView = "full" | "summary" | "notLoaded";

/**
 * A thread's newest `historyPageTurns` turns, oldest first. A page whose reply was too large to
 * read is asked again for one turn, then for that turn's summary, then for its envelope alone.
 */
export async function readHistory(
  request: Request,
  threadId: string,
  omitted: (note: OmittedTurn) => void = () => {},
): Promise<Obj[]> {
  const newest: { turn: Obj; view: ItemsView; droppedBytes: number }[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (newest.length < historyPageTurns) {
    let result: Obj;
    let limit = historyPageTurns - newest.length;
    let itemsView: ItemsView = "full";
    let droppedBytes = 0;
    for (;;) {
      try {
        result = obj(
          await request("thread/turns/list", {
            threadId,
            limit,
            sortDirection: "desc",
            itemsView,
            ...(cursor ? { cursor } : {}),
          }),
        );
        break;
      } catch (error) {
        // Servers without paged history still answer the deprecated whole-history read.
        if (!cursor && !newest.length && methodMissing(error))
          return wholeHistory(request, threadId);
        if (!(error instanceof OutputLineDroppedError)) throw error;
        droppedBytes = error.bytes;
        if (limit !== 1) limit = 1;
        else if (itemsView === "full") itemsView = "summary";
        else if (itemsView === "summary") itemsView = "notLoaded";
        else throw error; // No cursor survived even in the envelope; never invent one.
      }
    }
    if (!Array.isArray(result["data"])) throw new Error("Codex history page omitted its turns");
    // A page never holds more than was asked for; anything past the limit is ignored.
    for (const turn of result["data"].slice(0, limit))
      newest.push({ turn: obj(turn), view: itemsView, droppedBytes });
    const next = str(result["nextCursor"]);
    if (!next || !result["data"].length) break;
    if (seen.has(next)) throw new Error("Codex history repeated a page cursor");
    seen.add(next);
    cursor = next;
  }
  const turns = newest.toReversed();
  for (const { turn, view, droppedBytes } of turns)
    if (view !== "full")
      omitted({
        event: "thread-history-omitted",
        turnId: str(turn["id"]),
        item: "",
        bytes: droppedBytes,
        bytesAtLeast: true,
        reason: `Oversized turn history retained as ${view}`,
      });
  return turns.map(({ turn }) => turn);
}

/** The deprecated whole-history read: one reply, of which only the newest turns are kept. */
async function wholeHistory(request: Request, threadId: string): Promise<Obj[]> {
  const thread = obj(obj(await request("thread/read", { threadId, includeTurns: true }))["thread"]);
  if (!Array.isArray(thread["turns"])) throw new Error("Codex read omitted turn history");
  return list(thread["turns"]).slice(-historyPageTurns).map(obj);
}

function methodMissing(error: unknown): boolean {
  return error instanceof Error && /"code":\s*-32601\b/.test(error.message);
}

/** A thread's metadata without any turns it carried. */
export function withoutHistory(thread: Obj): Obj {
  return Object.fromEntries(Object.entries(thread).filter(([key]) => key !== "turns"));
}

/**
 * The recorded form of a history reply: its shape and counts, never its turns. The turns are
 * recorded once, as bounded `thread-history` notes, by whoever asked for them.
 */
export function compactHistoryReply(message: Obj): Obj {
  if (message["error"] !== undefined || message["result"] === undefined) return message;
  const result = obj(message["result"]);
  const thread = obj(result["thread"]);
  return {
    id: message["id"],
    result: {
      ...(Array.isArray(result["data"])
        ? { turns: result["data"].length, nextCursor: result["nextCursor"] ?? null }
        : {}),
      ...(result["thread"] !== undefined
        ? { thread: withoutHistory(thread), turns: list(thread["turns"]).length }
        : {}),
    },
  };
}

/** `read` ties a read's notes to its `thread-discovered` note; a failed read's notes never merge. */
export type HistoryNote =
  | { event: "thread-history"; threadId: string; read: number; turns: Obj[] }
  | {
      event: "thread-history-omitted";
      threadId: string;
      read: number;
      turnId: string;
      item: string;
      bytes: number;
      reason?: string;
      bytesAtLeast?: true;
    };

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * Splits history into notes that each fit the frame bound, in order. A turn too large for one
 * note is split by items, and its parts share the turn's id. An item larger than a whole note
 * is left out with a note saying so, the same outcome a live frame of that size would have.
 */
export function historyNotes(
  threadId: string,
  read: number,
  turns: Obj[],
  budget = noteBudget,
): HistoryNote[] {
  const notes: HistoryNote[] = [];
  let batch: Obj[] = [];
  let batchBytes = 0;
  const flush = () => {
    if (!batch.length) return;
    notes.push({ event: "thread-history", threadId, read, turns: batch });
    batch = [];
    batchBytes = 0;
  };
  const add = (turn: Obj, bytes: number) => {
    if (batchBytes + bytes > budget) flush();
    batch.push(turn);
    batchBytes += bytes;
  };
  for (const turn of turns) {
    const bytes = bytesOf(turn);
    if (bytes <= budget) {
      add(turn, bytes);
      continue;
    }
    const { items, ...shell } = turn;
    const shellBytes = bytesOf({ ...shell, items: [] });
    let part: unknown[] = [];
    let partBytes = shellBytes;
    const emitPart = () => {
      add({ ...shell, items: part }, partBytes);
      part = [];
      partBytes = shellBytes;
    };
    for (const item of list(items)) {
      const size = bytesOf(item) + 1;
      if (shellBytes + size > budget) {
        notes.push({
          event: "thread-history-omitted",
          threadId,
          read,
          turnId: str(turn["id"]),
          item: str(obj(item)["id"]),
          bytes: size - 1,
        });
        continue;
      }
      if (partBytes + size > budget) {
        emitPart();
        flush();
      }
      part.push(item);
      partBytes += size;
    }
    emitPart();
  }
  flush();
  return notes;
}
