// Offline stand-in for Codex's stored thread history. Codex keeps every thread's turns and
// returns them as each request asks: whole on a plain open, left out with `excludeTurns`, and
// a page at a time from `thread/turns/list`.
import { list, obj, str, type Obj } from "../native.ts";

export function historyStore() {
  const threads = new Map<string, Obj[]>();
  return {
    /** Records a reply's turns and leaves them out when the request excluded them. */
    reply(method: string, params: Obj, result: unknown): unknown {
      const reply = obj(result);
      const thread = obj(reply["thread"]);
      const id = str(thread["id"]);
      if (!id || !["thread/start", "thread/resume", "thread/fork", "thread/read"].includes(method))
        return result;
      // A read reports history; it never rewrites what an open already recorded.
      if (Array.isArray(thread["turns"]) && !(method === "thread/read" && threads.has(id)))
        threads.set(id, list(thread["turns"]).map(obj));
      const excluded =
        method === "thread/read"
          ? params["includeTurns"] !== true
          : params["excludeTurns"] === true;
      if (excluded) return { ...reply, thread: { ...thread, turns: [] } };
      // The deprecated whole-history read answers from the record, like Codex.
      return method === "thread/read" && threads.has(id)
        ? { ...reply, thread: { ...thread, turns: threads.get(id) } }
        : result;
    },
    /** `thread/turns/list`: the cursor is the index of the next turn. */
    page(params: Obj): unknown {
      const turns = threads.get(str(params["threadId"])) ?? [];
      const ordered = params["sortDirection"] === "desc" ? turns.toReversed() : turns;
      const start = Number(str(params["cursor"], "0"));
      const limit = typeof params["limit"] === "number" ? params["limit"] : ordered.length;
      const full = params["itemsView"] === "full";
      const data = ordered
        .slice(start, start + limit)
        .map((turn) => (full ? turn : Object.assign({}, turn, { items: [] })));
      const next = start + data.length;
      return {
        data,
        nextCursor: next < ordered.length ? String(next) : null,
        backwardsCursor: null,
      };
    },
    /** Live completion updates the stored turn, as Codex's own record does. */
    notified(method: string, params: unknown): void {
      if (method !== "turn/completed") return;
      const p = obj(params);
      const turn = obj(p["turn"]);
      const stored = threads.get(str(p["threadId"]))?.find((entry) => entry["id"] === turn["id"]);
      if (stored) stored["status"] = str(turn["status"], "completed");
    },
  };
}

/**
 * About 7 MB of readable history: forty 100 KB turns, a turn whose three 600 KB messages need
 * more than one note, and a turn holding one message larger than any note.
 */
const message = (id: string, label: string, words: number) => ({
  id,
  type: "agentMessage",
  text: `${label} ${"history ".repeat(words)}`,
});
export function longHistory(): Obj[] {
  return [
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `turn-${index}`,
      status: "completed",
      items: [message(`message-${index}`, `message ${index}`, 12_500)],
    })),
    {
      id: "split-turn",
      status: "completed",
      items: [0, 1, 2].map((index) => message(`split-${index}`, `split ${index}`, 75_000)),
    },
    {
      id: "oversized-turn",
      status: "completed",
      items: [message("oversized", "oversized", 150_000), message("after-oversized", "kept", 1)],
    },
  ];
}
