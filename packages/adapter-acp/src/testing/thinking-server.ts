// Scripted ACP agent whose thinking levels depend on the selected model; no provider executable.
import { createInterface } from "node:readline";
import { object, string } from "../data.ts";
const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const levels: Record<string, string[]> = { fast: ["low", "high"], deep: ["low", "high", "max"] };
let model = "fast";
// With --mode the agent has a permission mode that a model change puts back to its default.
let mode = "default";
let thinking = "low";
// With --hold-prompt a turn stays running until the mode changes.
let heldPrompt: unknown;
const modeOption = () =>
  process.argv.includes("--mode")
    ? [
        {
          id: "mode",
          category: "mode",
          type: "select",
          currentValue: mode,
          options: [
            { value: "default", name: "Default" },
            { value: "yolo", name: "YOLO" },
          ],
        },
      ]
    : [];
// With --legacy-mode the mode is a `modes` list set through `session/set_mode`.
const legacyMode = process.argv.includes("--legacy-mode");
const modes = () =>
  legacyMode
    ? {
        modes: {
          currentModeId: mode,
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
      }
    : {};
const configOptions = () => [
  ...modeOption(),
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
    currentValue: thinking,
    options: (levels[model] ?? []).map((value) => ({ value, name: value })),
  },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = object(JSON.parse(line));
  const result = (value: unknown) => write({ id: message["id"], result: value });
  if (message["method"] === "initialize")
    result({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
  else if (message["method"] === "session/new")
    result({ sessionId: "native", configOptions: configOptions(), ...modes() });
  else if (message["method"] === "session/set_config_option") {
    const params = object(message["params"]);
    if (params["configId"] === "thinking" && process.argv.includes("--refuse-thinking")) {
      write({ id: message["id"], error: { code: -32602, message: "Thinking level unavailable" } });
      return;
    }
    if (params["configId"] === "model") {
      model = string(params["value"]);
      mode = "default";
    }
    // With --ignore-mode the agent answers a mode change with its mode unchanged.
    if (params["configId"] === "mode" && !process.argv.includes("--ignore-mode"))
      mode = string(params["value"]);
    // With --ignore-thinking the agent answers a level change with its level unchanged.
    if (params["configId"] === "thinking" && !process.argv.includes("--ignore-thinking"))
      thinking = string(params["value"]);
    result({ configOptions: configOptions() });
    if (params["configId"] === "mode" && heldPrompt !== undefined) {
      write({ id: heldPrompt, result: { stopReason: "end_turn" } });
      heldPrompt = undefined;
    }
  } else if (message["method"] === "session/set_mode") {
    mode = string(object(message["params"])["modeId"]);
    result({});
  } else if (message["method"] === "session/prompt") {
    // With --leave-plan the agent leaves plan mode on its own during the turn.
    if (process.argv.includes("--leave-plan")) {
      mode = "default";
      write({
        method: "session/update",
        params: {
          sessionId: "native",
          update: { sessionUpdate: "current_mode_update", currentModeId: "default" },
        },
      });
    }
    if (process.argv.includes("--hold-prompt")) heldPrompt = message["id"];
    else result({ stopReason: "end_turn" });
  }
});
