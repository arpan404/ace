// Local protocol boundary only. Never starts a provider or a model.
import { createInterface } from "node:readline";
import { appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { object, list, string } from "../data.ts";
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const update = (value: unknown, sessionId = "native-root") =>
  send({ method: "session/update", params: { sessionId, update: value } });
const askShell = (id: number) => {
  update({
    sessionUpdate: "tool_call",
    toolCallId: "gated",
    kind: "execute",
    status: "pending",
    rawInput: { command: "rm -rf build" },
  });
  send({
    id,
    method: "session/request_permission",
    params: {
      sessionId: "native-root",
      toolCall: { toolCallId: "gated" },
      options: [
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Deny", kind: "reject_once" },
      ],
    },
  });
};
/** The prompt waiting on an answer to request 101 before it ends. */
let gatedPrompt: unknown;
let heldPrompt: unknown;
let heldTool = "held";
let heldCount = 0;
// A held prompt ends its turn when released, or only frees its command so a steer can cancel it.
let heldEndsTurn = true;
// The test releases a held turn by dropping a marker file into this directory: no timer decides.
const releaseDir = process.env.ACE_ACP_RELEASE_DIR;
const eventLog = process.env.ACE_ACP_EVENT_LOG;
const note = (event: string) => {
  if (eventLog) appendFileSync(eventLog, `${event}\n`);
};
const releaseHeld = () => {
  const promptId = heldPrompt;
  if (promptId === undefined) return;
  note("release");
  if (!heldEndsTurn) {
    update({ sessionUpdate: "tool_call_update", toolCallId: heldTool, status: "completed" });
    return;
  }
  // The turn ends before its command reports back, so nothing can cancel it in between.
  send({ id: promptId, result: { stopReason: "end_turn" } });
  heldPrompt = undefined;
  update({ sessionUpdate: "tool_call_update", toolCallId: heldTool, status: "completed" });
};
if (releaseDir)
  setInterval(() => {
    if (heldPrompt === undefined) return;
    let entries: string[];
    try {
      entries = readdirSync(releaseDir).toSorted();
    } catch {
      return;
    }
    const next = entries[0];
    if (next === undefined) return;
    try {
      unlinkSync(join(releaseDir, next));
    } catch {
      return;
    }
    releaseHeld();
  }, 25).unref();
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = object(JSON.parse(line));
  const params = object(frame["params"]);
  if (frame["method"] === "initialize")
    send({
      id: frame["id"],
      result: {
        protocolVersion: 1,
        agentInfo: { name: "antigravity-acp" },
        agentCapabilities: { loadSession: true },
      },
    });
  else if (frame["method"] === "session/load") {
    // History replay: a shell and a child that ran in an earlier process, not now.
    update({
      sessionUpdate: "tool_call",
      toolCallId: "old-shell",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "sleep 60" },
    });
    update(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old child" } },
      "old-child",
    );
    send({ id: frame["id"], result: {} });
  } else if (frame["method"] === "session/new")
    send({ id: frame["id"], result: { sessionId: "native-root" } });
  else if (frame["method"] === "session/prompt") {
    const text = string(object(list(params["prompt"])[0])["text"]);
    if (heldPrompt !== undefined) {
      send({ id: frame["id"], error: { code: -32603, message: "Overlapping prompt" } });
    } else if (text === "hold-shell-for-steer" || text === "hold-shell-natural") {
      // A command of a turn that waits for the test: releasing frees the shell, and a natural
      // turn also answers.
      heldPrompt = frame["id"];
      heldTool = text === "hold-shell-natural" ? "natural-shell" : "held-shell";
      heldEndsTurn = text === "hold-shell-natural";
      update({
        sessionUpdate: "tool_call",
        toolCallId: heldTool,
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "sleep 60" },
      });
    } else if (text === "hold-for-steer" || text.startsWith("hold-for-steer:")) {
      heldPrompt = frame["id"];
      heldTool = text === "hold-for-steer" ? "held" : `held-${++heldCount}`;
      heldEndsTurn = true;
      update({
        sessionUpdate: "tool_call",
        toolCallId: heldTool,
        kind: "read",
        status: "in_progress",
      });
    } else if (["shell", "controlled-shell", "antigravity-shell"].includes(text)) {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "s",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "sleep 60" },
      });
      send({
        id: frame["id"],
        result: { stopReason: text === "antigravity-shell" ? "end_turn" : "cancelled" },
      });
      if (text === "controlled-shell")
        send({
          id: 100,
          method: "session/request_permission",
          params: {
            sessionId: "native-root",
            toolCall: { toolCallId: "control", title: "Release execution evidence" },
            options: [{ optionId: "a", name: "Release", kind: "allow_once" }],
          },
        });
    } else if (text === "report-shell") {
      // Antigravity reports a shell carried from an earlier turn inside a later prompt.
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "s",
        status: "completed",
        rawOutput: { exitCode: 0 },
      });
      send({ id: frame["id"], result: { stopReason: "end_turn" } });
    } else if (text === "late-tool") {
      // The reply, then a tool of the root first reported after it, that never ends.
      send({ id: frame["id"], result: { stopReason: "end_turn" } });
      update({
        sessionUpdate: "tool_call",
        toolCallId: "late",
        kind: "read",
        status: "in_progress",
        rawInput: { path: "/big" },
      });
    } else if (text === "denied-shell") {
      gatedPrompt = frame["id"];
      askShell(101);
    } else if (text === "unanswered-shell") {
      askShell(102);
      send({ id: frame["id"], result: { stopReason: "end_turn" } });
    } else if (text === "failing-shell") {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "failing",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "sleep 60" },
      });
      send({ id: frame["id"], error: { code: -32603, message: "Internal error" } });
    } else send({ id: frame["id"], result: { stopReason: "end_turn" } });
  } else if (frame["method"] === "session/cancel" && heldPrompt !== undefined) {
    note("cancel");
    const promptId = heldPrompt;
    const toolId = heldTool;
    setTimeout(() => {
      update({ sessionUpdate: "tool_call_update", toolCallId: toolId, status: "cancelled" });
      // Antigravity says it was cancelled in message text before answering.
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "\n\nThe request was cancelled by the client." },
      });
      send({ id: promptId, result: { stopReason: "cancelled" } });
      if (heldPrompt === promptId) heldPrompt = undefined;
    }, 25);
  } else if (frame["id"] === 101 && Object.hasOwn(frame, "result")) {
    send({ id: gatedPrompt, result: { stopReason: "end_turn" } });
  } else if (frame["id"] === 100 && Object.hasOwn(frame, "result")) {
    update({ sessionUpdate: "tool_call_update", toolCallId: "control", status: "completed" });
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "s",
      status: "completed",
      rawOutput: { exitCode: 0 },
    });
  }
});
