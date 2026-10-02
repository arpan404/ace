import { object, string } from "../data.ts";
import { baseCapabilities, type AcpQuirks } from "./types.ts";
export const cursorQuirks: AcpQuirks = {
  provider: "cursor",
  command: "agent",
  args: ["acp"],
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
  capabilities(version) {
    const supported =
      /^\d{4}\.\d{2}\.\d{2}-/.test(version ?? "") && (version ?? "") >= "2026.09.26-";
    return {
      ...baseCapabilities,
      backgroundVisibility: "none",
      resume: supported,
      interruptCascades: supported,
      subagentTranscripts: supported,
      planMode: supported,
      imageInput: supported,
    };
  },
};
