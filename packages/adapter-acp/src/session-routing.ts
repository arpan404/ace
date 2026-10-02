import { object, string, type Data } from "./data.ts";
import { childAssociation } from "./association.ts";
import { nativeAgentKey } from "./keys.ts";
interface Child {
  id: string;
  parent: string;
  cancel: boolean;
  live: boolean;
}
/** Indexes make ordinary updates independent of historical child count. */
export class SessionRouting {
  readonly children = new Map<string, Child>();
  readonly toolOwners = new Map<string, string>();
  readonly byKey = new Map<string, Child>();
  readonly live = new Set<string>();
  readonly byParent = new Map<string, Set<string>>();
  readonly threadId: string;
  root: string;
  constructor(threadId: string, root = "") {
    this.threadId = threadId;
    this.root = root;
  }
  bindRoot(id: string): void {
    const previous = this.root;
    this.root = id;
    const provisional = this.children.get(id);
    if (provisional) {
      this.children.delete(id);
      this.byKey.delete(nativeAgentKey(this.threadId, id));
      this.live.delete(id);
      this.byParent.get(provisional.parent)?.delete(id);
    }
    for (const childId of this.byParent.get(previous) ?? []) {
      const child = this.children.get(childId);
      if (!child) continue;
      child.parent = id;
      this.index(child);
    }
    if (previous !== id) this.byParent.delete(previous);
  }
  receive(params: Data): void {
    const parent = string(params["sessionId"]);
    const update = object(params["update"]);
    const type = string(update["sessionUpdate"]);
    if (type === "tool_call" && typeof update["toolCallId"] === "string")
      this.toolOwners.set(update["toolCallId"], parent);
    const association = childAssociation(update);
    if (!association) {
      if (
        parent &&
        parent !== this.root &&
        ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(
          type,
        )
      ) {
        const child = this.children.get(parent) ?? {
          id: parent,
          parent: this.root,
          cancel: true,
          live: true,
        };
        child.live = true;
        this.children.set(parent, child);
        this.byKey.set(nativeAgentKey(this.threadId, parent), child);
        this.live.add(parent);
        this.index(child);
      }
      return;
    }
    const { id, status, terminal } = association;
    if (id === parent) return;
    const previous = this.children.get(id);
    if (previous?.parent !== parent) this.byParent.get(previous?.parent ?? "")?.delete(id);
    const capabilities = update["capabilities"];
    const child: Child = {
      id,
      parent,
      cancel:
        type !== "subagent_update" ||
        (capabilities !== undefined
          ? object(capabilities)["cancel"] != null
          : previous?.cancel === true),
      live: terminal ? false : status === "running" || previous?.live !== false,
    };
    this.children.set(id, child);
    this.byKey.set(nativeAgentKey(this.threadId, id), child);
    if (child.live) this.live.add(id);
    else this.live.delete(id);
    this.index(child);
  }
  index(child: Child): void {
    let children = this.byParent.get(child.parent);
    if (!children) {
      children = new Set();
      this.byParent.set(child.parent, children);
    }
    children.add(child.id);
  }
  get hasLiveChildren(): boolean {
    return this.live.size > 0;
  }
  descendants(id: string): Child[] {
    const result: Child[] = [];
    const found = new Set([id]);
    const queue = [id];
    for (let index = 0; index < queue.length; index++) {
      for (const childId of this.byParent.get(queue[index] ?? "") ?? []) {
        if (found.has(childId)) continue;
        const child = this.children.get(childId);
        if (!child) continue;
        found.add(childId);
        queue.push(childId);
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
