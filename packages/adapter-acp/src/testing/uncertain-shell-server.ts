// Local protocol boundary only. Never starts a provider or a model.
import { createInterface } from "node:readline";
import { object, list, string } from "../data.ts";
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const update = (value: unknown) =>
  send({ method: "session/update", params: { sessionId: "native-root", update: value } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = object(JSON.parse(line));
  const params = object(frame["params"]);
  if (frame["method"] === "initialize")
    send({
      id: frame["id"],
      result: { protocolVersion: 1, agentInfo: { name: "antigravity-acp" } },
    });
  else if (frame["method"] === "session/new")
    send({ id: frame["id"], result: { sessionId: "native-root" } });
  else if (frame["method"] === "session/prompt") {
    const text = string(object(list(params["prompt"])[0])["text"]);
    if (["shell", "controlled-shell", "antigravity-shell"].includes(text)) {
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
    } else send({ id: frame["id"], result: { stopReason: "end_turn" } });
  } else if (frame["id"] === 100 && Object.hasOwn(frame, "result")) {
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "s",
      status: "completed",
      rawOutput: { exitCode: 0 },
    });
  }
});
