import type { ApprovalTarget } from "@ace/protocol";
import { bareToolName } from "./tool-names.ts";

const scopeKeys = new Set([
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
]);

/** The approval target a provider's gate on an ace tool call shows the person. */
export function describeAceAction(
  tool: string,
  description: string,
  riskClass: ApprovalTarget["riskClass"],
  input: unknown,
): ApprovalTarget {
  // Measurement reads are safe to approve as view operations; a nested input is an effect.
  const bare = bareToolName(tool);
  if (
    (bare === "screen_measure_interaction" || bare === "browser_measure_interaction") &&
    input &&
    typeof input === "object"
  ) {
    const field = bare === "screen_measure_interaction" ? "action" : "interaction";
    const selectsTab =
      bare === "browser_measure_interaction" && Reflect.get(input, "tabId") !== undefined;
    riskClass =
      Reflect.get(input, field) === undefined && !selectsTab ? "read-only" : "external-effect";
  }
  const scope =
    input && typeof input === "object"
      ? Object.entries(input).filter(([key]) => scopeKeys.has(key))
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
