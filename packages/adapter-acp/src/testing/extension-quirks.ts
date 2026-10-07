import { object, string } from "../data.ts";
import { baseCapabilities, type AcpQuirks } from "../quirks/types.ts";
export const extensionQuirks: AcpQuirks = {
  provider: "acp",
  command: "",
  args: [],
  experimental: false,
  clientMeta: { subagents: {}, parameterizedModelPicker: true },
  toolKind(update) {
    const input = object(update["rawInput"]);
    const name = string(input["_toolName"]);
    if (name === "task" || string(update["title"]).startsWith("Task:")) return "agent.spawn";
    if (name === "createPlan" || string(update["title"]).startsWith("Create Plan")) return "plan";
    if (input["providerIdentifier"] && input["toolName"]) return "mcp";
    if (name === "updateTodos") return "todo";
    if (name === "askQuestion") return "ask_user";
    if (name === "generateImage") return "image";
    return undefined;
  },
  classifyError(text) {
    return text.startsWith("\n\nError: ")
      ? { kind: "provider", message: text.slice(9) }
      : undefined;
  },
  capabilities() {
    return {
      ...baseCapabilities,
      backgroundVisibility: "none",
      resume: true,
      interruptCascades: true,
      subagentTranscripts: true,
      planMode: true,
      imageInput: true,
    };
  },
};
