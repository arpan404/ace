import type { ApprovalTarget } from "@ace/protocol";
import { bareToolName } from "./tool-names.ts";

const scopeKeys = new Set([
  "threadId",
  "workspaceId",
  "provider",
  "model",
  "role",
  "streamId",
  "simId",
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
    (bare === "screen_measure" || bare === "browser_measure") &&
    input &&
    typeof input === "object"
  ) {
    const field = bare === "screen_measure" ? "action" : "interaction";
    riskClass = Reflect.get(input, field) === undefined ? "read-only" : "external-effect";
  }
  // Listing history reads; moving through it navigates.
  if (bare === "browser_history" && input && typeof input === "object")
    riskClass = Reflect.get(input, "direction") === undefined ? "read-only" : "external-effect";
  // Listing tabs or installed extensions reads; the other actions change the browser.
  if (bare === "browser_tabs" && input && typeof input === "object")
    riskClass = (Reflect.get(input, "action") ?? "list") === "list" ? "read-only" : riskClass;
  if (bare === "browser_settings" && input && typeof input === "object")
    riskClass = Reflect.get(input, "action") === "extensions" ? "read-only" : riskClass;
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
