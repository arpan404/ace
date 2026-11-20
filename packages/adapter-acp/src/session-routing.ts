import { object, string, type Data } from "./data.ts";
import { childAssociation } from "./association.ts";
import { nativeAgentKey } from "./keys.ts";
interface Child {
  id: string;
  parent: string;
  cancel: boolean;
  live: boolean;
  /** Seen only through its own updates, never a subagent association: it ends with the root's prompt. */
  implicit: boolean;
}
const terminalStatus = new Set(["completed", "failed", "cancelled"]);
const toolOwnerLimit = 4096;
/** Indexes make ordinary updates independent of historical child count. */
export class SessionRouting {
  readonly children = new Map<string, Child>();
  readonly toolOwners = new Map<string, string>();
  private completedTools = new Set<string>();
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
    const toolId = string(update["toolCallId"]);
    const toolKey = JSON.stringify([parent, toolId]);
    // A tool frame that only reports an end is never proof that its session is working: it can
    // arrive after the child finished, and must not bring the child back.
    const passive =
      ["tool_call", "tool_call_update"].includes(type) &&
      (terminalStatus.has(string(update["status"])) ||
        (type === "tool_call_update" &&
          this.completedTools.has(toolKey) &&
          !["pending", "in_progress"].includes(string(update["status"]))));
    if (toolId && ["tool_call", "tool_call_update"].includes(type)) {
      if (["completed", "failed", "cancelled"].includes(string(update["status"]))) {
        this.completedTools.delete(toolKey);
        this.completedTools.add(toolKey);
        if (this.completedTools.size > 4096) {
          const oldest = this.completedTools.values().next().value;
          if (oldest) this.completedTools.delete(oldest);
        }
      } else if (["pending", "in_progress"].includes(string(update["status"])))
        this.completedTools.delete(toolKey);
    }
    if (toolId && terminalStatus.has(string(update["status"]))) {
      if (this.toolOwners.get(toolId) === parent) this.toolOwners.delete(toolId);
    } else if (type === "tool_call" && toolId) {
      this.toolOwners.delete(toolId);
      this.toolOwners.set(toolId, parent);
      if (this.toolOwners.size > toolOwnerLimit) {
        const oldest = this.toolOwners.keys().next().value;
        if (oldest !== undefined) this.toolOwners.delete(oldest);
      }
    }
    const association = childAssociation(update);
    if (!association) {
      if (
        parent &&
        parent !== this.root &&
        !passive &&
        ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(
          type,
        )
      ) {
        const child = this.children.get(parent) ?? {
          id: parent,
          parent: this.root,
          cancel: true,
          live: true,
          implicit: true,
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
      implicit: false,
    };
    this.children.set(id, child);
    this.byKey.set(nativeAgentKey(this.threadId, id), child);
    if (child.live) this.live.add(id);
    else this.live.delete(id);
    this.index(child);
  }
  /** The root's prompt answered: a session nothing associates as a subagent ends with it. */
  promptEnded(): void {
    for (const id of this.live) {
      const child = this.children.get(id);
      if (!child?.implicit) continue;
      child.live = false;
      this.live.delete(id);
    }
  }
  /** A cancelled child gave no sign within its grace: no longer counted as working. */
  expire(id: string): boolean {
    const child = this.children.get(id);
    if (!child?.live) return false;
    child.live = false;
    this.live.delete(id);
    return true;
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
  /** Live children that hold new input back. A stray session ends with the root's prompt instead. */
  get holdsInput(): boolean {
    for (const id of this.live) if (!this.children.get(id)?.implicit) return true;
    return false;
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
