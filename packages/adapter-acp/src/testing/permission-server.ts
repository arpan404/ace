// Scripted ACP permission boundary; no provider executable or credentials.
import { createInterface } from "node:readline";
import { object } from "../data.ts";
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let prompt: unknown;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = object(JSON.parse(line));
  const result = (value: unknown) => write({ id: message["id"], result: value });
  if (message["method"] === "initialize")
    result({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  else if (message["method"] === "session/new" || message["method"] === "session/load")
    result({
      sessionId: "native",
      ...(process.argv.includes("--no-selectors")
        ? {}
        : process.argv.includes("--legacy")
          ? {
              modes: {
                currentModeId: "build",
                availableModes: [
                  { id: "read-only", name: "Read only" },
                  { id: "build", name: "Build" },
                  { id: "bypassPermissions", name: "Bypass" },
                ],
              },
            }
          : {
              configOptions: [
                {
                  id: "tools",
                  category: "mode",
                  type: "select",
                  currentValue: "build",
                  options: [
                    { value: "read-only", name: "Read only" },
                    { value: "build", name: "Build" },
                    { value: "bypassPermissions", name: "Bypass" },
                  ],
                },
              ],
            }),
    });
  else if (
    message["method"] === "session/set_config_option" ||
    message["method"] === "session/set_mode"
  )
    result({});
  else if (message["method"] === "session/prompt") {
    prompt = message["id"];
    if (process.argv.includes("--no-permission")) {
      result({ stopReason: "end_turn" });
      return;
    }
    write({
      id: 100,
      method: "session/request_permission",
      params: {
        sessionId: "native",
        toolCall: {
          toolCallId: "shell",
          kind: "execute",
          title: "workspace inspection",
          rawInput: { command: "pwd" },
        },
        options: [
          { optionId: "once", kind: "allow_once", name: "Once" },
          { optionId: "no", kind: "reject_once", name: "Deny" },
        ],
      },
    });
  } else if (message["id"] === 100) {
    write({
      method: "session/update",
      params: {
        sessionId: "native",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(message["result"]) },
        },
      },
    });
    write({ id: prompt, result: { stopReason: "end_turn" } });
  }
});
