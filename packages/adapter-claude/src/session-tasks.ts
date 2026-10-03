import { list, object, string, type Data } from "./native.ts";

interface LiveTask {
  id: string;
  spawn: string;
  parent: string;
  live: boolean;
}
/** Retain live ancestry and unsettled tools only. Capacity fails the process visibly, never evicts live work. */
export class SessionTasks {
  readonly live = new Map<string, LiveTask>();
  private readonly pendingParents = new Map<string, string>();
  private readonly bySpawn = new Map<string, LiveTask>();
  private readonly retired = new Map<string, string>();
  private readonly children = new Map<string, number>();
  observe(data: Data): void {
    if (data["type"] === "assistant" || data["type"] === "user")
      for (const value of list(object(data["message"])["content"])) {
        const block = object(value);
        if (block["type"] === "tool_use") {
          const id = string(block["id"]);
          if (!id) continue;
          const parent = string(data["parent_tool_use_id"]);
          const task = this.bySpawn.get(id);
          if (task && task.parent !== parent) {
            this.removeChild(task.parent);
            const previous = this.bySpawn.get(task.parent);
            task.parent = parent;
            this.addChild(parent);
            if (previous) this.prune(previous);
          } else if (!task) {
            if (!this.pendingParents.has(id) && this.pendingParents.size >= 1024)
              throw new Error("Claude unsettled tool capacity reached");
            this.pendingParents.set(id, parent);
          }
        } else if (block["type"] === "tool_result")
          this.pendingParents.delete(string(block["tool_use_id"]));
      }
    if (data["type"] !== "system") return;
    const id = string(data["task_id"]);
    if (data["subtype"] === "task_started" && id) {
      const spawn = string(data["tool_use_id"]);
      const known = this.live.get(id);
      if (!known && this.live.size >= 512) throw new Error("Claude live task capacity reached");
      const task = known ?? { id, spawn, parent: this.pendingParents.get(spawn) ?? "", live: true };
      if (!known) this.addChild(task.parent);
      this.live.set(id, task);
      if (spawn) {
        this.bySpawn.set(spawn, task);
        this.pendingParents.delete(spawn);
      }
    } else if (data["subtype"] === "task_updated" || data["subtype"] === "task_notification") {
      const status = string(data["status"], string(object(data["patch"])["status"]));
      if (["completed", "failed", "killed", "stopped"].includes(status)) {
        const task = this.live.get(id);
        if (task) {
          task.live = false;
          this.prune(task);
        }
        // Completed ancestry remains only while a descendant still needs it.
      }
    }
  }
  cascade(targetSpawn: string): { ids: string[]; uncertain: boolean } {
    if (!targetSpawn) return { ids: [], uncertain: true };
    const ids: string[] = [];
    let uncertain = false;
    for (const [id, task] of this.live) {
      if (!task.live || task.spawn === targetSpawn) continue;
      let parent = task.parent;
      const visited = new Set<string>();
      while (parent && parent !== targetSpawn) {
        if (visited.has(parent)) {
          uncertain = true;
          break;
        }
        visited.add(parent);
        const next = this.bySpawn.get(parent)?.parent ?? this.retired.get(parent);
        if (next === undefined) {
          uncertain = true;
          break;
        }
        parent = next;
      }
      if (parent === targetSpawn) ids.push(id);
    }
    return { ids, uncertain };
  }
  private addChild(parent: string): void {
    if (parent) this.children.set(parent, (this.children.get(parent) ?? 0) + 1);
  }
  private removeChild(parent: string): void {
    const remaining = (this.children.get(parent) ?? 0) - 1;
    if (remaining > 0) this.children.set(parent, remaining);
    else this.children.delete(parent);
  }
  private prune(task: LiveTask): void {
    let current: LiveTask | undefined = task;
    while (current && !current.live && !this.children.has(current.spawn)) {
      this.live.delete(current.id);
      if (current.spawn) {
        this.bySpawn.delete(current.spawn);
        if (this.retired.size >= 512) this.retired.delete(this.retired.keys().next().value ?? "");
        this.retired.set(current.spawn, current.parent);
      }
      this.removeChild(current.parent);
      current = this.bySpawn.get(current.parent);
    }
  }
}
