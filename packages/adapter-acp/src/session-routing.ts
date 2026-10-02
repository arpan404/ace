import { object, string, type Data } from "./data.ts";
interface Child {
  id: string;
  parent: string;
  cancel: boolean;
  live: boolean;
}
/** Native routing for queued I/O and selective cancellation, independent of core status. */
export class SessionRouting {
  readonly children = new Map<string, Child>();
  readonly toolOwners = new Map<string, string>();
  receive(params: Data): void {
    const parent = string(params["sessionId"]);
    const update = object(params["update"]);
    const type = string(update["sessionUpdate"]);
    if (type === "tool_call" && typeof update["toolCallId"] === "string")
      this.toolOwners.set(update["toolCallId"], parent);
    if (!["subagent_spawned", "subagent_state_update", "subagent_update"].includes(type)) return;
    const id = string(update["subagentSessionId"] ?? update["sessionId"]);
    if (!id) return;
    const previous = this.children.get(id);
    const status =
      typeof update["state"] === "string" ? update["state"] : object(update["state"])["state"];
    const terminal = ["completed", "failed", "cancelled", "idle"].includes(string(status));
    const capabilities = update["capabilities"];
    this.children.set(id, {
      id,
      parent: previous?.parent ?? parent,
      cancel:
        type !== "subagent_update" ||
        (capabilities !== undefined
          ? object(capabilities)["cancel"] != null
          : previous?.cancel === true),
      live: terminal ? false : status === "running" || previous?.live !== false,
    });
  }
  get hasLiveChildren(): boolean {
    return [...this.children.values()].some((child) => child.live);
  }
  descendants(id: string): Child[] {
    const result: Child[] = [];
    const found = new Set([id]);
    for (let index = 0; index < found.size; index++) {
      const parent = [...found][index];
      for (const child of this.children.values())
        if (child.parent === parent && !found.has(child.id)) {
          found.add(child.id);
          result.push(child);
        }
    }
    return result;
  }
  owner(params: Data, root: string): string {
    return (
      string(params["sessionId"]) ||
      this.toolOwners.get(
        string(params["toolCallId"] ?? object(params["toolCall"])["toolCallId"]),
      ) ||
      root
    );
  }
}
