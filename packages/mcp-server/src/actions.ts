import type { ApprovalTarget } from "@ace/protocol";
import { agentControlToolCatalog } from "./agent-control.ts";
import { builtinToolCatalog, handoffToolCatalog } from "./catalog.ts";

const definitions = new Map(
  [...agentControlToolCatalog, ...builtinToolCatalog, ...handoffToolCatalog].map((entry) => [
    entry.name,
    entry,
  ]),
);
/** Callers must establish ace server identity before using a bare tool name. */
export function aceToolAction(name: string, input: unknown): ApprovalTarget | undefined {
  const tool = name.startsWith("mcp__ace__") ? name.slice("mcp__ace__".length) : name;
  const definition = definitions.get(tool);
  if (!definition) return undefined;
  const parsed = definition.input.safeParse(input);
  if (!parsed.success) return undefined;
  return describeAceAction(tool, definition.description, definition.riskClass, parsed.data);
}
export function describeAceAction(
  tool: string,
  description: string,
  riskClass: ApprovalTarget["riskClass"],
  input: unknown,
): ApprovalTarget {
  // Measurement reads are safe to approve as view operations; a nested input is an effect.
  if (
    (tool === "screen_measure_interaction" || tool === "ace_browser_measure_interaction") &&
    input &&
    typeof input === "object"
  ) {
    const field = tool === "screen_measure_interaction" ? "action" : "interaction";
    const selectsTab =
      tool === "ace_browser_measure_interaction" && Reflect.get(input, "tabId") !== undefined;
    riskClass =
      Reflect.get(input, field) === undefined && !selectsTab ? "read-only" : "external-effect";
  }
  const scope =
    input && typeof input === "object"
      ? Object.entries(input).filter(([key]) =>
          [
            "threadId",
            "workspaceId",
            "provider",
            "model",
            "role",
            "streamId",
            "deviceId",
            "appId",
            "url",
            "ref",
            "action",
            "interaction",
            "sessionId",
            "tabId",
            "key",
          ].includes(key),
        )
      : [];
  return {
    tool,
    input,
    origin: "ace",
    riskClass: riskClass ?? "external-effect",
    access:
      riskClass === "read-only" ? "read" : riskClass === "agent-execution" ? "execute" : "write",
    description:
      `${description}${scope.length ? ` Target: ${JSON.stringify(Object.fromEntries(scope))}.` : ""}`.slice(
        0,
        2048,
      ),
  };
}
