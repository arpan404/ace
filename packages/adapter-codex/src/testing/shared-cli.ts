// Offline multi-thread app-server. One process hosts many threads, as a real Codex app-server does.
import { createInterface } from "node:readline";
import { obj, str } from "../native.ts";

// Process-level `-c key=value` overrides (built-in skills) precede the subcommand.
const argv = process.argv.slice(2);
const args = argv.filter((arg, index) => arg !== "-c" && argv[index - 1] !== "-c").join(" ");
if (args === "--version") {
  process.stdout.write("codex-cli 0.159.1\n");
  process.exit(0);
}
if (args !== "app-server") process.exit(64);

const write = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);
const notify = (method: string, params: unknown) => write({ method, params });
const parents = new Map<string, string>();
const loaded = new Set<string>();
const active = new Map<string, string>();
let threads = 0;
let turns = 0;

function complete(threadId: string, status = "completed"): void {
  const turn = active.get(threadId);
  if (!turn) return;
  active.delete(threadId);
  notify("turn/completed", { threadId, turn: { id: turn, status } });
}
function start(threadId: string): string {
  const turn = `turn-${++turns}`;
  active.set(threadId, turn);
  notify("turn/started", { threadId, turn: { id: turn } });
  return turn;
}

for await (const line of createInterface({ input: process.stdin })) {
  const frame = obj(JSON.parse(line));
  const id = frame["id"];
  const method = str(frame["method"]);
  const p = obj(frame["params"]);
  const respond = (result: unknown) => write({ id, result });
  if (!method || id === undefined) continue;
  if (method === "initialize") respond({ userAgent: "codex/0.159.1", pid: process.pid });
  else if (method === "permissionProfile/list") respond({ data: [] });
  else if (method === "thread/start" || method === "thread/resume") {
    const thread =
      method === "thread/resume" ? str(p["threadId"]) : `thread-${process.pid}-${++threads}`;
    loaded.add(thread);
    const opened = () => respond({ thread: { id: thread, cwd: p["cwd"] }, model: "fake" });
    // A slow workspace holds its open so a caller can cancel while Codex is still starting.
    if (str(p["cwd"]).endsWith("slow")) setTimeout(opened, 2000);
    else opened();
  } else if (method === "turn/start") {
    const thread = str(p["threadId"]);
    const text = str(obj(Array.isArray(p["input"]) ? p["input"][0] : undefined)["text"]);
    if (text === "crash") process.exit(3);
    respond({ turn: { id: `turn-${turns + 1}` } });
    const turn = start(thread);
    if (text === "spawn-child") {
      // The child speaks before its parent reveals it; only Codex's records link them.
      const child = `${thread}-child`;
      parents.set(child, thread);
      start(child);
      notify("item/completed", {
        threadId: child,
        turnId: active.get(child),
        item: { type: "agentMessage", id: `${child}-says`, text: "child working" },
      });
      complete(child);
      complete(thread);
      continue;
    }
    notify("item/completed", {
      threadId: thread,
      turnId: turn,
      item: { type: "agentMessage", id: `${turn}-reply`, text: `${thread} heard ${text}` },
    });
    if (text === "ask-by-turn")
      // Some server requests name only their turn.
      write({
        id: `ask-${turn}`,
        method: "mcpServer/elicitation/request",
        params: { turnId: turn, serverName: "docs", mode: "form", message: "Which file?" },
      });
    else if (text !== "hold") complete(thread);
  } else if (method === "turn/interrupt") {
    respond({});
    complete(str(p["threadId"]), "interrupted");
  } else if (method === "thread/read") {
    const thread = str(p["threadId"]);
    const parent = parents.get(thread);
    respond({
      thread: {
        id: thread,
        ...(parent ? { parentThreadId: parent } : {}),
        status: { type: "idle" },
        turns: [],
      },
    });
  } else if (method === "thread/unsubscribe") {
    respond({ status: "unsubscribed" });
    notify("thread/closed", { threadId: str(p["threadId"]) });
  } else if (method === "thread/loaded/list") respond({ data: [...loaded] });
  else if (method === "thread/backgroundTerminals/list") respond({ data: [] });
  else write({ id, error: { code: -32601, message: `unsupported ${method}` } });
}
