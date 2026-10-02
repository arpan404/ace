// Offline provider boundary. This process never imports or starts a real Codex binary.
import { createInterface } from "node:readline";
import { list, obj, str } from "../native.ts";
const write = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);
const notify = (method: string, params: unknown) => write({ method, params });
const item = (threadId: string, turnId: string, data: unknown, complete = true) =>
  notify(complete ? "item/completed" : "item/started", { threadId, turnId, item: data });
const message = (text: string, id = "proof") =>
  item("native", "turn", { type: "agentMessage", id, text });
const active = new Map<string, string>();
const terminals = new Map<string, { itemId: string; processId: string }[]>();
let pendingKind = "";
function end(threadId = "native", status = "completed"): void {
  const id = active.get(threadId) ?? "turn";
  active.delete(threadId);
  notify("turn/completed", { threadId, turn: { id, status } });
}
for await (const line of createInterface({ input: process.stdin })) {
  const frame = obj(JSON.parse(line));
  const p = obj(frame["params"]);
  const method = str(frame["method"]);
  const id = frame["id"];
  if (!method && id === 100) {
    message(JSON.stringify(frame["result"]), "response-proof");
    notify("serverRequest/resolved", { threadId: "native", requestId: 100 });
    end();
    continue;
  }
  const respond = (result: unknown) => write({ id, result });
  if (method === "initialize") {
    if (obj(p["capabilities"])["experimentalApi"] !== true)
      write({ id, error: { message: "Experimental API is required" } });
    else
      respond({
        userAgent: "ace/0.159.1",
        codexHome: "/fake",
        platformFamily: "unix",
        platformOs: "macos",
      });
  } else if (method === "thread/start" || method === "thread/resume")
    respond({
      thread: { id: "native", cwd: process.cwd(), status: { type: "idle" }, turns: [] },
      model: "fake-model",
    });
  else if (method === "turn/start") {
    const text = str(obj(list(p["input"])[0])["text"]);
    pendingKind = text;
    respond({ turn: { id: "turn" } });
    active.set("native", "turn");
    notify("turn/started", { threadId: "native", turn: { id: "turn" } });
    if (text === "question")
      item("native", "turn", {
        id: "q",
        type: "agentMessage",
        delivery: "async",
        questions: [{ title: "Tabs?", options: ["Tabs", "Spaces"] }],
        text: "",
      });
    else if (text === "plan") {
      notify("thread/settings/updated", {
        threadId: "native",
        collaborationMode: { mode: "plan" },
      });
      item("native", "turn", { id: "p", type: "plan", text: "# Test plan" });
      end();
    } else if (text === "approval" || text === "input")
      write({
        id: 100,
        method:
          text === "approval"
            ? "item/commandExecution/requestApproval"
            : "item/tool/requestUserInput",
        params: {
          threadId: "native",
          turnId: "turn",
          itemId: "missing",
          availableDecisions: [
            "accept",
            { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } },
            "cancel",
          ],
          questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }],
        },
      });
    else if (text === "tree") {
      terminals.set("native", [{ itemId: "root-exec", processId: "root-process" }]);
      terminals.set("child", [{ itemId: "child-exec", processId: "child-process" }]);
      active.set("child", "child-turn");
      notify("turn/started", { threadId: "child", turn: { id: "child-turn" } });
      item("native", "turn", {
        id: "spawn",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "child",
        agentPath: "/root/worker",
      });
      for (const [thread, entries] of terminals)
        item(
          thread,
          active.get(thread)!,
          {
            id: entries[0]!.itemId,
            type: "commandExecution",
            command: "loop",
            status: "inProgress",
            processId: null,
            commandActions: [],
          },
          false,
        );
    } else if (text === "hidden-child") {
      active.set("hidden", "hidden-turn");
      end();
    } else if (text === "exit") process.exit(7);
    else if (text === "finish") end();
    else if (text === "Implement the plan." || obj(p["collaborationMode"])["mode"]) {
      message(JSON.stringify(p), "plan-proof");
      end();
    }
  } else if (method === "turn/steer") {
    if (p["expectedTurnId"] !== active.get(str(p["threadId"])))
      write({ id, error: { message: "stale turn" } });
    else {
      respond({ turnId: p["expectedTurnId"] });
      message(`steered: ${str(obj(list(p["input"])[0])["text"])}`);
      if (pendingKind === "question") end();
    }
  } else if (method === "thread/queue/add") {
    respond({});
    message(`queued: ${str(obj(list(p["input"])[0])["text"])}`, "queue-proof");
  } else if (method === "turn/interrupt") {
    respond({});
    end(str(p["threadId"]), "interrupted");
  } else if (method === "thread/backgroundTerminals/list") {
    const entries = terminals.get(str(p["threadId"])) ?? [];
    // Require pagination before the matching terminal is returned.
    respond(
      p["cursor"]
        ? { data: entries, nextCursor: null }
        : { data: [], nextCursor: entries.length ? "page2" : null },
    );
  } else if (method === "thread/backgroundTerminals/terminate") {
    const thread = str(p["threadId"]);
    const entries = terminals.get(thread) ?? [];
    const terminal = entries.find((t) => t.processId === p["processId"]);
    if (!terminal) write({ id, error: { message: "Wrong process id" } });
    else {
      terminals.set(
        thread,
        entries.filter((t) => t !== terminal),
      );
      respond({});
      item(thread, thread === "native" ? "turn" : "child-turn", {
        id: terminal.itemId,
        type: "commandExecution",
        status: "completed",
        command: "loop",
        aggregatedOutput: `terminated ${terminal.processId}`,
        exitCode: 0,
        commandActions: [],
      });
    }
  } else if (method === "thread/loaded/list")
    respond({ data: active.has("hidden") ? ["native", "hidden"] : ["native"], nextCursor: null });
  else if (method === "thread/read")
    respond({
      thread: {
        id: p["threadId"],
        parentThreadId: "native",
        cwd: process.cwd(),
        status: { type: "active" },
        turns: [{ id: active.get(str(p["threadId"])), status: "inProgress" }],
      },
    });
  else if (method !== "initialized")
    write({ id, error: { message: `Unexpected request: ${method}` } });
}
