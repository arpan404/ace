import type { Fact } from "@ace/core";
import { list, object, raw, string, type Data } from "./native.ts";
import { ClaudeState, type NativeTask } from "./state.ts";

function register(state: ClaudeState, data: Data, background: boolean): NativeTask {
  const id = string(data["task_id"]);
  const prior = state.tasks.get(id);
  const merged = { ...prior?.data, ...data };
  const spawn = string(merged["tool_use_id"]);
  const owner = state.toolOwners.get(spawn) ?? prior?.owner ?? state.root;
  const child =
    merged["task_type"] === "local_agent" && spawn
      ? state.child(spawn, owner, background, id, prior?.terminalStatus)
      : prior?.child;
  const task: NativeTask = {
    data: merged,
    owner,
    ...(child ? { child } : {}),
    ...(spawn ? { item: state.key("tool", spawn) } : prior?.item ? { item: prior.item } : {}),
    background: background || prior?.background === true,
    terminal: prior?.terminal ?? false,
    ...(prior?.terminalStatus ? { terminalStatus: prior.terminalStatus } : {}),
  };
  state.tasks.set(id, task);
  if (task.terminal && task.child) state.endChild(task, task.terminalStatus ?? "failed");
  if (task.background && !task.terminal)
    state.emit({
      type: "background.started",
      agent: owner,
      task: state.key("task", id),
      kind:
        merged["task_type"] === "local_agent"
          ? "subagent"
          : merged["task_type"] === "local_bash"
            ? "shell"
            : merged["task_type"] === "monitor"
              ? "monitor"
              : "other",
      title: string(merged["description"], "Claude background task"),
      stoppable: true,
      ...(task.item ? { item: task.item } : {}),
      ...(child ? { childAgent: child } : {}),
      ambient: merged["ambient"] === true,
      ...(typeof merged["output_file"] === "string" ? { outputPath: merged["output_file"] } : {}),
      raw: [raw(data)],
    });
  return task;
}
function finish(
  state: ClaudeState,
  id: string,
  task: NativeTask,
  status: string,
  now: number,
): void {
  if (!["completed", "failed", "killed", "stopped"].includes(status)) return;
  if (task.background && !task.terminal && !state.active.has(state.root))
    state.expectWake(now, task);
  task.terminal = true;
  task.terminalStatus = status;
  state.missing.delete(id);
  state.endChild(task, status);
  releaseTask(task);
  if (task.background)
    state.emit({
      type: "background.ended",
      task: state.key("task", id),
      status: status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped",
    });
}
export function taskFrame(state: ClaudeState, data: Data, now: number): boolean {
  const subtype = string(data["subtype"]);
  if (subtype === "background_tasks_changed") {
    const next = new Set<string>();
    for (const value of list(data["tasks"])) {
      const task = object(value);
      const id = string(task["task_id"]);
      if (!id) continue;
      next.add(id);
      state.missing.delete(id);
      register(state, task, true);
    }
    for (const id of state.level)
      if (!next.has(id)) {
        const task = state.tasks.get(id);
        if (task && !task.terminal) {
          state.missing.set(id, now + 1_000);
          state.expectWake(now, task);
        }
      }
    state.level = next;
    return true;
  }
  if (!subtype.startsWith("task_")) return false;
  const id = string(data["task_id"]);
  if (!id) return false;
  if (subtype === "task_started") {
    const task = register(state, data, data["is_backgrounded"] === true);
    if (task.child && typeof data["prompt"] === "string")
      state.emit({
        type: "item.upsert",
        agent: task.child,
        item: state.key("prompt", task.child),
        draft: {
          type: "message",
          role: "user",
          parts: [{ type: "text", text: data["prompt"] }],
          synthetic: true,
          complete: true,
          ...state.keepMessageRaw(state.key("prompt", task.child), data, task.child),
        },
      });
    return true;
  }
  const task = state.tasks.get(id) ?? register(state, data, data["is_backgrounded"] === true);
  task.data = { ...task.data, ...data };
  if (subtype === "task_progress") {
    state.emit({ type: "signal", agent: task.child ?? task.owner });
    if (task.child)
      state.emit({
        type: "activity",
        agent: task.child,
        activity: "tool",
        detail: string(data["description"]),
      });
    return true;
  }
  if (subtype === "task_updated" || subtype === "task_notification") {
    const status = string(data["status"], string(object(data["patch"])["status"]));
    if (subtype === "task_notification" && task.background) state.expectWake(now, task);
    finish(state, id, task, status, now);
    return true;
  }
  return false;
}
export function taskTick(state: ClaudeState, now: number): Fact[] {
  for (const id of state.missing.expired(now)) {
    const task = state.tasks.get(id);
    if (task && !task.terminal) {
      task.terminal = true;
      task.terminalStatus = "failed";
      state.emit({ type: "background.ended", task: state.key("task", id), status: "unknown" });
      state.endChild(task, "failed");
      releaseTask(task);
    }
  }
  return state.facts;
}

function releaseTask(task: NativeTask): void {
  // Only terminal identity and ancestry are needed after settlement.
  task.data = {
    ...(typeof task.data["task_type"] === "string" ? { task_type: task.data["task_type"] } : {}),
    ...(typeof task.data["tool_use_id"] === "string"
      ? { tool_use_id: task.data["tool_use_id"] }
      : {}),
    ambient: task.data["ambient"] === true,
  };
}
