// Real local JSON-RPC boundary for session tests. Never invokes a provider.
import { createInterface } from "node:readline";
import { object, string, list } from "../data.ts";
if (process.argv.includes("--version")) {
  process.stdout.write("2026.09.26-test\n");
  process.exit(0);
}
if (process.argv.includes("status")) {
  process.stdout.write("Logged in\n");
  process.exit(0);
}
function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function result(id: unknown, value: unknown) {
  send({ id, result: value });
}
function update(value: unknown) {
  send({ method: "session/update", params: { sessionId: "native-root", update: value } });
}
let prompt: unknown;
let held = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = object(JSON.parse(line));
  const params = object(message["params"]);
  const method = message["method"];
  if (method === "initialize")
    result(message["id"], {
      protocolVersion: 1,
      agentInfo: { name: "antigravity-acp", version: "1.2.1" },
    });
  else if (method === "session/new" || method === "session/load")
    result(message["id"], { sessionId: "native-root" });
  else if (method === "session/set_config_option") result(message["id"], {});
  else if (method === "session/prompt") {
    if (held) {
      send({ id: message["id"], error: { code: -1, message: "Reprompt cancelled a live turn" } });
      return;
    }
    const text = string(object(list(params["prompt"])[0])["text"]);
    if (text === "hold") {
      prompt = message["id"];
      held = true;
      update({
        sessionUpdate: "tool_call",
        toolCallId: "plan",
        kind: "other",
        rawInput: { _toolName: "createPlan" },
        status: "pending",
      });
      send({
        id: 100,
        method: "cursor/create_plan",
        params: { toolCallId: "plan", name: "Review", plan: "Synthetic plan" },
      });
      send({
        id: 101,
        method: "cursor/task",
        params: { toolCallId: "plan", agentId: "not-a-child" },
      });
      send({ id: 102, method: "future/unknown", params: {} });
    } else if (text === "child") {
      update({ sessionUpdate: "subagent_spawned", subagentSessionId: "native-child" });
      result(message["id"], { stopReason: "end_turn" });
    } else if (text === "tree") {
      update({ sessionUpdate: "subagent_spawned", subagentSessionId: "branch" });
      update({ sessionUpdate: "subagent_spawned", subagentSessionId: "sibling" });
      send({
        method: "session/update",
        params: {
          sessionId: "branch",
          update: { sessionUpdate: "subagent_spawned", subagentSessionId: "leaf" },
        },
      });
      result(message["id"], { stopReason: "end_turn" });
    } else if (text === "permission") {
      prompt = message["id"];
      held = true;
      send({
        id: 100,
        method: "session/request_permission",
        params: {
          sessionId: "native-root",
          toolCall: { toolCallId: "interaction_choice", title: "Pick one" },
          options: [{ optionId: "a", name: "A", kind: "allow_once" }],
        },
      });
    } else if (text === "die") process.exit(7);
    else {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      result(message["id"], { stopReason: "end_turn" });
    }
  } else if (method === "session/cancel") {
    if (params["sessionId"] === "native-child")
      update({
        sessionUpdate: "subagent_state_update",
        subagentSessionId: "native-child",
        state: "cancelled",
      });
    if (held) {
      held = false;
      result(prompt, { stopReason: "cancelled" });
    }
  } else if (message["id"] === 100 && "result" in message) {
    send({ method: "test/answer", params: message["result"] });
    if (held) {
      held = false;
      result(prompt, { stopReason: "end_turn" });
    }
  } else if (message["id"] === 101 && "result" in message)
    send({ method: "test/information-ack", params: message["result"] });
  else if (message["id"] === 102 && "error" in message)
    send({ method: "test/unknown-rejected", params: message["error"] });
});
