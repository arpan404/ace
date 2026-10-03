import { object, string, type Data } from "./data.ts";
export function childAssociation(update: Data) {
  const type = string(update["sessionUpdate"]);
  if (!["subagent_spawned", "subagent_state_update", "subagent_update"].includes(type))
    return undefined;
  const id = string(update["subagentSessionId"] ?? update["sessionId"]);
  if (!id) return undefined;
  const status = string(
    typeof update["state"] === "string" ? update["state"] : object(update["state"])["state"],
  );
  return {
    id,
    type,
    status,
    terminal: ["completed", "failed", "cancelled", "idle"].includes(status),
  };
}
