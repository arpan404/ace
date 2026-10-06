// Offline provider boundary. This process never imports or starts a real Codex binary.
import { createInterface } from "node:readline";
import { list, obj, str } from "../native.ts";
if (process.env["ACE_FAKE_RESUME"] === "ignore-term") process.on("SIGTERM", () => {});
const args: string[] = [];
const overrides = new Map<string, string>();
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === "-c") {
    const value = process.argv[++index];
    if (!value || !value.includes("=")) throw new Error("Invalid synthetic CLI override");
    const at = value.indexOf("=");
    overrides.set(value.slice(0, at), value.slice(at + 1));
  } else if (arg) args.push(arg);
}
if (args.join(" ") === "--version") {
  process.stdout.write("codex-cli 0.159.1\n");
  process.exit(0);
}
if (args.join(" ") === "login status") {
  process.stderr.write("Logged in using ChatGPT\n");
  process.exit(0);
}
if (args.join(" ") !== "app-server") {
  process.stderr.write("Expected app-server launch\n");
  process.exit(64);
}
const write = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);
const notify = (method: string, params: unknown) => write({ method, params });
const item = (threadId: string, turnId: string, data: unknown, complete = true) =>
  notify(complete ? "item/completed" : "item/started", { threadId, turnId, item: data });
const message = (text: string, id = "proof") =>
  item("native", "turn", { type: "agentMessage", id, text });
const active = new Map<string, string>();
const terminals = new Map<string, { itemId: string; processId: string }[]>();
let pendingKind = "";
let queued = 0;
let policyTurn = 0;
let discoveryFailed = false;
const sourceHistory = [
  { id: "prior-turn", text: "private native earlier context" },
  { id: "source-turn", text: "private native selected context" },
  { id: "later-turn", text: "private native future secret" },
];
let forkHistory: typeof sourceHistory = [];
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
  } else if (method === "thread/fork") {
    if (p["threadId"] !== "source-native" || p["lastTurnId"] !== "source-turn") {
      write({ id, error: { message: "Incorrect fork source or boundary" } });
      continue;
    }
    const boundary = sourceHistory.findIndex((turn) => turn.id === p["lastTurnId"]);
    forkHistory = sourceHistory.slice(0, boundary + 1);
    respond({
      thread: { id: "fork-native", cwd: process.cwd(), status: { type: "idle" }, turns: [] },
      model: "fake-model",
    });
  } else if (method === "thread/settings/update") {
    respond({});
    notify("item/completed", {
      threadId: p["threadId"],
      turnId: "configured",
      item: {
        id: "configuration-proof",
        type: "agentMessage",
        text: JSON.stringify({
          model: p["model"],
          effort: p["effort"],
          serviceTier: p["serviceTier"],
        }),
      },
    });
  } else if (method === "thread/start" || method === "thread/resume") {
    const config = obj(obj(p["config"])["mcp_servers.ace"]);
    notify("ace/connection", {
      aceConnection: {
        url: config["url"],
        authenticated:
          /^Bearer [a-f0-9]{64}$/.test(str(obj(config["http_headers"])["Authorization"])) &&
          !process.env["ACE_MCP_BEARER_TOKEN"],
      },
    });
    if (process.env["ACE_FAKE_RESUME"] === "historical-interactions") {
      respond({
        thread: {
          id: "native",
          cwd: process.cwd(),
          status: { type: "idle" },
          turns: [
            {
              id: "old",
              status: "completed",
              items: [
                ...["answered-a", "answered-b"].map((questionId) => ({
                  type: "agentMessage",
                  id: questionId,
                  delivery: "async",
                  text: "Previously answered",
                  questions: [{ title: "Continue?", options: ["yes"] }],
                })),
                { type: "plan", id: "old-plan", text: "Old resolved plan" },
              ],
            },
          ],
        },
        model: "fake-model",
      });
      continue;
    }
    if (process.env["ACE_FAKE_RESUME"] === "resume-completed") {
      process.stdout.write(
        `${JSON.stringify({ id, result: { thread: { id: "native", status: { type: "active" }, turns: [{ id: "resumed", status: "inProgress", items: [] }] } } })}\n${JSON.stringify({ method: "turn/completed", params: { threadId: "native", turn: { id: "resumed", status: "completed" } } })}\n`,
      );
      continue;
    }
    if (process.env["ACE_FAKE_RESUME"] === "active") active.set("native", "resumed");
    const shellHistory = process.env["ACE_FAKE_RESUME"] === "shell";
    if (shellHistory)
      terminals.set("native", [{ itemId: "hydrated", processId: "hydrated-process" }]);
    respond({
      thread: {
        id: "native",
        cwd: process.cwd(),
        status: { type: "idle" },
        turns: shellHistory
          ? [
              {
                id: "old",
                status: "completed",
                items: [
                  { type: "agentMessage", id: "history", text: "historical message" },
                  {
                    type: "commandExecution",
                    id: "hydrated",
                    status: "inProgress",
                    command: "loop",
                    commandActions: [],
                  },
                ],
              },
            ]
          : active.has("native")
            ? [{ id: "resumed", status: "inProgress", items: [] }]
            : [],
      },
      model: "fake-model",
    });
  } else if (method === "turn/start") {
    const text = str(obj(list(p["input"])[0])["text"]);
    if (process.env["ACE_FAKE_RESUME"] === "overlap-policy") {
      if (p["threadId"] === "child") {
        respond({ turn: { id: "child-next" } });
        active.set("child", "child-next");
        notify("turn/started", { threadId: "child", turn: { id: "child-next" } });
        end("child");
        continue;
      }
      const turnId = `overlap-${++policyTurn}`;
      const approve = (requestId: number, threadId: string, turn: string, itemId: string) =>
        write({
          id: requestId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId,
            turnId: turn,
            itemId,
            command: "pwd",
            availableDecisions: ["accept", "decline"],
          },
        });
      if (policyTurn === 2) approve(typeof id === "number" ? id : 101, "native", turnId, "pre-ack");
      respond({ turn: { id: turnId } });
      active.set("native", turnId);
      notify("turn/started", { threadId: "native", turn: { id: turnId } });
      if (policyTurn === 1) {
        item("native", turnId, {
          id: "spawn",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "child",
          agentPath: "/root/worker",
        });
        active.set("child", "child-turn");
        notify("turn/started", { threadId: "child", turn: { id: "child-turn" } });
        item("child", "child-turn", {
          type: "agentMessage",
          id: "child-question",
          delivery: "async",
          text: "Continue?",
          questions: [{ title: "Continue?", options: ["yes"] }],
        });
        item(
          "native",
          turnId,
          {
            id: "old-shell",
            type: "commandExecution",
            command: "loop",
            commandActions: [],
            status: "inProgress",
          },
          false,
        );
      } else {
        approve(102, "child", "child-turn", "child-approval");
        approve(103, "native", "overlap-1", "old-shell");
      }
      end();
      continue;
    }
    if (process.env["ACE_FAKE_RESUME"] === "policy-boundary") {
      if (text === "invalid-policy") {
        respond({ turn: {} });
        continue;
      }
      if (text === "reject-policy") {
        write({ id, error: { code: -32000, message: "Turn rejected" } });
        continue;
      }
      const turnId = `policy-${++policyTurn}`;
      respond({ turn: { id: turnId } });
      active.set("native", turnId);
      notify("turn/started", { threadId: "native", turn: { id: turnId } });
      item("native", turnId, {
        type: "agentMessage",
        id: `policy-proof-${policyTurn}`,
        text: JSON.stringify(p),
      });
      if (policyTurn === 1) {
        terminals.set("native", [{ itemId: "policy-shell", processId: "policy-process" }]);
        item(
          "native",
          turnId,
          {
            type: "commandExecution",
            id: "policy-shell",
            command: "loop",
            commandActions: [],
            status: "inProgress",
          },
          false,
        );
      }
      end();
      continue;
    }
    if (p["threadId"] === "fork-native") {
      respond({ turn: { id: "fork-continuation" } });
      notify("turn/started", { threadId: "fork-native", turn: { id: "fork-continuation" } });
      item("fork-native", "fork-continuation", {
        id: "fork-history-proof",
        type: "agentMessage",
        text: `${forkHistory.map((turn) => turn.text).join("|")}; answer: ${text}`,
      });
      notify("turn/completed", {
        threadId: "fork-native",
        turn: { id: "fork-continuation", status: "completed" },
      });
      continue;
    }
    if (process.env["ACE_FAKE_RESUME"] === "reply-before-start" && active.has("native")) {
      write({ id, error: { message: "active turn must be steered" } });
      continue;
    }
    if (text === "Implement the plan.")
      item(str(p["threadId"]), "turn", {
        type: "userMessage",
        id: "plan-answer-echo",
        content: p["input"],
      });
    pendingKind = text;
    if (text === "same-chunk") {
      process.stdout.write(
        `${JSON.stringify({ id, result: { turn: { id: "turn" } } })}\n${JSON.stringify({ method: "turn/started", params: { threadId: "native", turn: { id: "turn" } } })}\n${JSON.stringify({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: "completed" } } })}\n`,
      );
      continue;
    }
    respond({ turn: { id: "turn" } });
    active.set("native", "turn");
    if (process.env["ACE_FAKE_RESUME"] !== "reply-before-start")
      notify("turn/started", { threadId: "native", turn: { id: "turn" } });
    if (text === "replay-answered") {
      for (const questionId of ["answered-a", "answered-b"])
        item("native", "old", {
          type: "agentMessage",
          id: questionId,
          delivery: "async",
          text: "Previously answered",
          questions: [{ title: "Continue?", options: ["yes"] }],
        });
      end();
    } else if (text === "two-questions") {
      for (const questionId of ["q", "q2"])
        item("native", "turn", {
          id: questionId,
          type: "agentMessage",
          delivery: "async",
          questions: [{ title: "Tabs?", options: ["Tabs", "Spaces"] }],
        });
    } else if (text === "question")
      item("native", "turn", {
        id: "q",
        type: "agentMessage",
        delivery: "async",
        questions: [
          {
            title: "Tabs?",
            options: [
              { id: "tabs", label: "Tabs" },
              { id: "spaces", label: "Spaces" },
            ],
          },
        ],
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
          active.get(thread) ?? "turn",
          {
            id: entries[0]?.itemId ?? "",
            type: "commandExecution",
            command: "loop",
            status: "inProgress",
            processId: null,
            commandActions: [],
          },
          false,
        );
    } else if (text === "evicted-child" || text === "evicted-child-live") {
      for (let i = 0; i < 256; i++)
        notify("thread/status/changed", { threadId: `unrelated-${i}`, status: { type: "idle" } });
      notify("turn/started", { threadId: "lost-child", turn: { id: "lost-turn" } });
      item("lost-child", "lost-turn", {
        id: "lost-message",
        type: "agentMessage",
        text: "early completed history",
      });
      notify("turn/completed", {
        threadId: "lost-child",
        turn: { id: "lost-turn", status: "completed" },
      });
      for (let i = 0; i < 300; i++)
        notify("thread/status/changed", { threadId: `noise-${i}`, status: { type: "idle" } });
      item("native", "turn", {
        id: "spawn-lost",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "lost-child",
      });
      if (text === "evicted-child") end();
    } else if (text === "overflow-read") {
      notify("turn/started", { threadId: "overflow-child", turn: { id: "overflow-turn" } });
      for (let i = 0; i < 70; i++)
        notify("item/agentMessage/delta", {
          threadId: "overflow-child",
          itemId: "m",
          delta: `${i}`,
        });
      item("native", "turn", {
        id: "spawn-overflow",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "overflow-child",
      });
      notify("turn/completed", {
        threadId: "overflow-child",
        turn: { id: "overflow-turn", status: "completed" },
      });
      end();
    } else if (text === "orphan") {
      active.set("orphan", "orphan-turn");
      notify("thread/status/changed", { threadId: "orphan", status: { type: "idle" } });
      item("orphan", "orphan-turn", {
        id: "orphan-text",
        type: "agentMessage",
        text: "early transcript",
      });
    } else if (text === "hidden-child") {
      active.set("hidden", "hidden-turn");
      end();
    } else if (["unrelated", "failed-discovery", "delta-shell"].includes(text)) {
      if (text === "delta-shell") {
        terminals.set("native", [{ itemId: "delta-exec", processId: "delta-process" }]);
        notify("item/commandExecution/outputDelta", {
          threadId: "native",
          turnId: "turn",
          itemId: "delta-exec",
          delta: "running",
        });
      }
      end();
    } else if (text === "exit") {
      if (process.env["ACE_FAKE_RESUME"] === "exit-diagnostic") {
        process.stderr.write("x".repeat(10000) + "\n");
        process.stderr.write("offline app-server failure api_key=super-secret-test-token\n");
      }
      process.exit(7);
    } else if (text === "terminal-proof") {
      message(JSON.stringify([...terminals.values()].flat()), "terminal-proof");
      end();
    } else if (text === "finish") end();
    else if (text === "Implement the plan." || obj(p["collaborationMode"])["mode"]) {
      message(JSON.stringify(p), "plan-proof");
      end();
    }
  } else if (method === "turn/steer") {
    if (p["expectedTurnId"] !== active.get(str(p["threadId"])))
      write({ id, error: { message: "stale turn" } });
    else {
      respond({ turnId: p["expectedTurnId"] });
      item(str(p["threadId"]), str(p["expectedTurnId"]), {
        type: "userMessage",
        id: "answer-echo",
        content: p["input"],
      });
      message(`steered: ${str(obj(list(p["input"])[0])["text"])}`);
      if (pendingKind === "question") end();
    }
  } else if (method === "thread/queue/add") {
    queued++;
    respond({});
    message(`queued: ${str(obj(list(p["input"])[0])["text"])}`, "queue-proof");
  } else if (method === "thread/queue/list")
    respond({
      data: Array.from({ length: queued }, (_, i) => ({ id: `queued-${i}` })),
      nextCursor: null,
    });
  else if (method === "turn/interrupt") {
    if (process.env["ACE_FAKE_RESUME"] === "read-completed" && p["threadId"] === "hidden") {
      write({ id, error: { message: "stale read turn" } });
      continue;
    }
    respond({});
    end(str(p["threadId"]), "interrupted");
  } else if (method === "thread/backgroundTerminals/list") {
    if (process.env["ACE_FAKE_RESUME"] === "terminal-loop") {
      respond({ data: [], nextCursor: "loop" });
      continue;
    }
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
  } else if (method === "thread/loaded/list") {
    if (pendingKind === "failed-discovery" && !discoveryFailed) {
      discoveryFailed = true;
      active.set("hidden", "hidden-turn");
      write({ id, error: { code: -32000, message: "discovery failed" } });
      continue;
    }
    if (pendingKind === "unrelated") {
      respond({ data: ["unrelated"], nextCursor: null });
      continue;
    }
    if (pendingKind.startsWith("evicted-child")) {
      respond({ data: ["native", "lost-child"], nextCursor: null });
      continue;
    }
    respond({ data: active.has("hidden") ? ["native", "hidden"] : ["native"], nextCursor: null });
  } else if (method === "thread/read") {
    if (process.env["ACE_FAKE_RESUME"] === "read-completed" && p["threadId"] === "hidden") {
      active.delete("hidden");
      const turn = { id: "hidden-turn", status: "inProgress", items: [] };
      process.stdout.write(
        `${JSON.stringify({ id, result: { thread: { id: "hidden", parentThreadId: "native", status: { type: "active" }, turns: [turn] } } })}\n${JSON.stringify({ method: "turn/completed", params: { threadId: "hidden", turn: { ...turn, status: "completed" } } })}\n`,
      );
      continue;
    }
    if (/^(?:unrelated-|noise-)/.test(str(p["threadId"]))) {
      respond({
        thread: { id: p["threadId"], parentThreadId: null, status: { type: "idle" }, turns: [] },
      });
      continue;
    }
    if (p["threadId"] === "lost-child") {
      respond({
        thread: {
          id: "lost-child",
          parentThreadId: "native",
          status: { type: "idle" },
          turns: [
            {
              id: "lost-turn",
              status: "completed",
              items: [
                { id: "lost-message", type: "agentMessage", text: "recovered completed history" },
              ],
            },
          ],
        },
      });
      continue;
    }
    if (p["threadId"] === "overflow-child") {
      if (!discoveryFailed) {
        discoveryFailed = true;
        if (process.env["ACE_FAKE_RESUME"] === "omitted-history")
          respond({
            thread: {
              id: "overflow-child",
              parentThreadId: "native",
              status: { type: "idle" },
            },
          });
        else write({ id, error: { code: -32000, message: "read failed" } });
        continue;
      }
      respond({
        thread: {
          id: "overflow-child",
          parentThreadId: "native",
          status: { type: "idle" },
          turns: [
            {
              id: "overflow-turn",
              status: "completed",
              items: [{ id: "m", type: "agentMessage", text: "recovered" }],
            },
          ],
        },
      });
      continue;
    }
    respond({
      thread: {
        id: p["threadId"],
        parentThreadId:
          p["threadId"] === "unrelated"
            ? "other-root"
            : p["threadId"] === "other-root"
              ? null
              : "native",
        cwd: process.cwd(),
        status: { type: "active" },
        turns: [{ id: active.get(str(p["threadId"])), status: "inProgress" }],
      },
    });
  } else if (method !== "initialized")
    write({ id, error: { message: `Unexpected request: ${method}` } });
}
