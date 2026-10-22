// Scripted ACP agent whose thinking levels depend on the selected model; no provider executable.
import { createInterface } from "node:readline";
import { object, string } from "../data.ts";
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const levels: Record<string, string[]> = { fast: ["low", "high"], deep: ["low", "high", "max"] };
let model = "fast";
const configOptions = () => [
  {
    id: "model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [
      { value: "fast", name: "Fast" },
      { value: "deep", name: "Deep" },
    ],
  },
  {
    id: "thinking",
    category: "thought_level",
    type: "select",
    currentValue: "low",
    options: (levels[model] ?? []).map((value) => ({ value, name: value })),
  },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = object(JSON.parse(line));
  const result = (value: unknown) => write({ id: message["id"], result: value });
  if (message["method"] === "initialize")
    result({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  else if (message["method"] === "session/new")
    result({ sessionId: "native", configOptions: configOptions() });
  else if (message["method"] === "session/set_config_option") {
    const params = object(message["params"]);
    if (params["configId"] === "model") model = string(params["value"]);
    result({ configOptions: configOptions() });
  } else if (message["method"] === "session/prompt") result({ stopReason: "end_turn" });
});
