// Offline app-server that shares threads and produces oversized readable JSON lines.
import { createInterface } from "node:readline";
import { obj, str, list, type Obj } from "../native.ts";
const writeRaw = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);
let partialLine = false;
const queued: unknown[] = [];
const write = (data: unknown) => {
  if (partialLine) queued.push(data);
  else writeRaw(data);
};
function flushLine(): void {
  if (!partialLine) return;
  process.stdout.write("\n");
  partialLine = false;
  for (const data of queued.splice(0)) writeRaw(data);
}
const threads = new Map<string, Obj[]>();
const notify = (method: string, params: unknown) => write({ method, params });
const message = (id: string, size: number) => ({
  id,
  type: "agentMessage",
  text: "readable ".repeat(size),
});
let count = 0;
let turnCount = 0;
let holdPageFor = "";
const ephemeral = new Map<string, string>();
let heldReply: unknown;
let heldPage: { id: unknown; result: unknown } | undefined;
for await (const line of createInterface({ input: process.stdin })) {
  const m = obj(JSON.parse(line));
  const p = obj(m["params"]);
  const method = str(m["method"]);
  const id = m["id"];
  if (method === "thread/unsubscribe") flushLine();
  const respond = (result: unknown) => write({ id, result });
  if (id === undefined) continue;
  const thread = str(p["threadId"]);
  if (method === "initialize") respond({ pid: process.pid });
  else if (method === "permissionProfile/list") respond({ data: [] });
  else if (method === "thread/start" || method === "thread/resume") {
    const name = thread || `thread-${++count}`;
    if (!threads.has(name))
      threads.set(
        name,
        name === "history"
          ? [
              ...[0, 1, 2, 3].map((n) => ({
                id: `small-${n}`,
                status: "completed",
                items: [message(`kept-${n}`, 90)],
              })),
              { id: "huge", status: "completed", items: [message("huge-item", 600)] },
              {
                id: "summary-huge",
                status: "completed",
                items: [message("summary-huge-item", 600)],
              },
              { id: "after", status: "completed", items: [message("after-item", 1)] },
            ]
          : [],
      );
    respond({ thread: { id: name, turns: [] }, model: "fake" });
  } else if (method === "turn/start") {
    const text = str(obj(list(p["input"])[0])["text"]);
    const turn: { id: string; status: string; items: Obj[] } = {
      id: `turn-${++turnCount}`,
      status: "inProgress",
      items: [],
    };
    const history = threads.get(thread) ?? [];
    history.push(turn);
    threads.set(thread, history);
    respond({ turn: { id: turn.id } });
    notify("turn/started", { threadId: thread, turn: { id: turn.id } });
    if (text === "hold") {
      turn.items.push({
        id: `${turn.id}-shell`,
        type: "commandExecution",
        status: "inProgress",
        command: "sleep",
        cwd: "/tmp",
      });
      notify("item/started", { threadId: thread, turnId: turn.id, item: turn.items[0] });
    } else if (
      text === "drop-item" ||
      text === "drop-background" ||
      text === "drop-unseen-background"
    ) {
      const item = {
        id: `${turn.id}-shell`,
        type: "commandExecution",
        status: "inProgress",
        command: "echo",
        cwd: "/tmp",
      };
      turn.items.push(item);
      if (text !== "drop-unseen-background")
        notify("item/started", { threadId: thread, turnId: turn.id, item });
      item.status = text.includes("background") ? "inProgress" : "completed";
      Object.assign(item, { aggregatedOutput: "readable ".repeat(600) });
      notify("item/completed", {
        threadId: thread,
        turnId: turn.id,
        item: { ...item, aggregatedOutput: "readable ".repeat(600) },
      });
      turn.status = "completed";
      notify("turn/completed", { threadId: thread, turn: { id: turn.id, status: turn.status } });
    } else if (text === "drop-completion" || text === "unattributed") {
      turn.status = "completed";
      const params = {
        threadId: thread,
        turn: { id: turn.id, status: turn.status },
        output: "readable ".repeat(600),
      };
      if (text === "unattributed")
        write({ padding: "readable ".repeat(600), method: "turn/completed", params });
      else notify("turn/completed", params);
    } else {
      turn.status = "completed";
      notify("item/completed", {
        threadId: thread,
        turnId: turn.id,
        item: message(`${turn.id}-reply`, 1),
      });
      notify("turn/completed", { threadId: thread, turn: { id: turn.id, status: turn.status } });
    }
  } else if (method === "thread/read") {
    const turns = threads.get(thread) ?? [];
    respond({
      thread: {
        id: thread,
        status: {
          type:
            ephemeral.has(thread) || turns.some((turn) => turn["status"] === "inProgress")
              ? "active"
              : "idle",
        },
      },
    });
  } else if (method === "thread/turns/list") {
    const history = threads.get(thread) ?? [];
    const start = Number(str(p["cursor"], "0"));
    const limit = typeof p["limit"] === "number" ? p["limit"] : 4;
    const data = history.slice(start, start + limit).map((turn) => {
      if (p["itemsView"] === "notLoaded")
        return { id: turn["id"], status: turn["status"], items: [] };
      if (p["itemsView"] === "summary" && turn["id"] !== "summary-huge")
        return Object.assign({}, turn, { items: [message("summary", 1)] });
      return turn;
    });
    const result = {
      data,
      nextCursor: start + data.length < history.length ? String(start + data.length) : null,
    };
    if (holdPageFor === thread) {
      holdPageFor = "";
      heldPage = { id, result: structuredClone(result) };
      notify("test/history-held", { threadId: thread });
    } else respond(result);
  } else if (method === "thread/loaded/list") respond({ data: [...threads.keys()] });
  else if (method === "account/rateLimits/read") respond({});
  else if (method === "thread/settings/update") {
    if (p["model"] === "partial-flush") {
      flushLine();
      respond({});
      continue;
    }
    if (p["model"] === "partial-reply") {
      partialLine = true;
      process.stdout.write(JSON.stringify({ id, result: { padding: "readable ".repeat(600) } }));
      continue;
    }
    if (p["model"] === "partial-start") {
      respond({});
      const turn = `ephemeral-${++turnCount}`;
      ephemeral.set(thread, turn);
      partialLine = true;
      process.stdout.write(
        JSON.stringify({
          method: "turn/started",
          params: { threadId: thread, turn: { id: turn }, output: "readable ".repeat(600) },
        }),
      );
      continue;
    }
    if (p["model"] === "ephemeral-start") {
      const turn = `ephemeral-${++turnCount}`;
      ephemeral.set(thread, turn);
      notify("turn/started", {
        threadId: thread,
        turn: { id: turn },
        output: "readable ".repeat(600),
      });
    }
    if (p["model"] === "ephemeral-end") {
      const turn = ephemeral.get(thread);
      ephemeral.delete(thread);
      notify("turn/completed", {
        threadId: thread,
        turn: { id: turn, status: "completed" },
        output: "readable ".repeat(600),
      });
    }
    if (p["model"] === "hold-reply") {
      heldReply = id;
      continue;
    }
    if (p["model"] === "release-reply" && heldReply !== undefined) {
      write({ id: heldReply, result: {} });
      heldReply = undefined;
    }
    if (p["model"] === "finish-shell")
      for (const turn of threads.get(thread) ?? [])
        for (const value of list(turn["items"])) {
          const item = obj(value);
          if (item["status"] !== "inProgress") continue;
          item["status"] = "completed";
          delete item["aggregatedOutput"];
          notify("item/completed", { threadId: thread, turnId: turn["id"], item });
        }
    if (p["model"] === "hold-history") holdPageFor = thread;
    if (p["model"] === "dropped-start") {
      const turn = { id: `turn-${++turnCount}`, status: "inProgress", items: [] };
      threads.get(thread)?.push(turn);
      notify("turn/started", { threadId: thread, turn, output: "readable ".repeat(600) });
      if (heldPage) {
        write(heldPage);
        heldPage = undefined;
      }
    }
    respond(p["model"] === "oversized" ? { padding: "readable ".repeat(600) } : {});
  } else if (method === "turn/interrupt") {
    for (const turn of threads.get(thread) ?? [])
      if (turn["status"] === "inProgress") {
        turn["status"] = "interrupted";
        for (const value of list(turn["items"])) {
          const item = obj(value);
          item["status"] = "completed";
          notify("item/completed", { threadId: thread, turnId: turn["id"], item });
        }
        notify("turn/completed", {
          threadId: thread,
          turn: { id: turn["id"], status: "interrupted" },
        });
      }
    respond({});
  } else if (method === "thread/unsubscribe") respond({ status: "unsubscribed" });
  else if (method === "thread/backgroundTerminals/list")
    respond({
      data: (threads.get(thread) ?? [])
        .flatMap((turn) => list(turn["items"]).map(obj))
        .filter((item) => item["type"] === "commandExecution" && item["status"] === "inProgress")
        .map((item) => ({ processId: item["id"], itemId: item["id"] })),
    });
  else write({ id, error: { code: -32601, message: "unsupported" } });
}
