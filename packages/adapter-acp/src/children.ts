import { childAssociation } from "./association.ts";
import type { Fact } from "@ace/core";
import { object, string, type Data } from "./data.ts";
import { TranslationState, type AgentState, type ToolState } from "./state.ts";
export function backgroundChild(state: TranslationState, tool: ToolState, facts: Fact[]): void {
  const child = tool.child;
  if (
    !child ||
    child.parent !== tool.owner.key ||
    child.terminal ||
    object(tool.data["rawOutput"])["isBackground"] !== true
  )
    return;
  child.background = true;
  state.backgroundTools.add(tool);
  state.start(child, facts, "spawn");
  facts.push({ type: "agent.linked", agent: child.key, background: true });
  if (tool.task) return;
  tool.task = state.key("background");
  const owned = state.childBackgroundTools.get(child.nativeId) ?? new Set<ToolState>();
  owned.add(tool);
  state.childBackgroundTools.set(child.nativeId, owned);
  facts.push({
    type: "background.started",
    agent: tool.owner.key,
    task: tool.task,
    kind: "subagent",
    title: string(tool.data["title"]),
    item: tool.key,
    childAgent: child.key,
    stoppable: false,
    raw: [...tool.raw],
  });
}
export function childUpdate(
  state: TranslationState,
  parent: AgentState,
  update: Data,
  frame: unknown,
  facts: Fact[],
): boolean {
  const association = childAssociation(update);
  if (!association || association.id === parent.nativeId) return false;
  const { id, type, status } = association;
  const child = state.agent(id, facts);
  const meta = object(object(update["_meta"])["cursor"]);
  const nativeTool = string(meta["toolCallId"]);
  const previousTool = state.childTools.get(id);
  const tool = nativeTool
    ? state.tool(parent, nativeTool)
    : previousTool?.owner === parent
      ? previousTool
      : undefined;
  if (previousTool && previousTool !== tool) {
    delete previousTool.child;
    delete child.spawn;
    state.childTools.delete(id);
  }
  if (child.pendingSpawnKey) {
    state.pendingChildren.delete(child.pendingSpawnKey);
    delete child.pendingSpawnKey;
  }
  if (nativeTool && !tool) {
    child.pendingSpawnKey = JSON.stringify([parent.key, nativeTool]);
    state.pendingChildren.set(child.pendingSpawnKey, child);
  }
  const input = object(tool?.data["rawInput"]);
  // Draft association updates only patch metadata; null/omitted state never proves idle.
  child.parent = parent.key;
  if (tool) {
    child.spawn = tool.key;
    tool.child = child;
    state.childTools.set(id, tool);
  }
  facts.push({
    type: "agent.seen",
    agent: child.key,
    parent: parent.key,
    ...(tool ? { spawnedBy: tool.key } : {}),
    origin: "provider_subagent",
    fidelity: "full",
    native: { provider: state.quirks.provider, nativeId: id },
    cwd: state.cwd,
    ...(typeof update["name"] === "string" ? { role: update["name"] } : {}),
    ...(typeof meta["model"] === "string" ? { model: meta["model"] } : {}),
    ...(string(input["description"] ?? update["title"])
      ? { name: string(input["description"] ?? update["title"]) }
      : {}),
  });
  if (tool) {
    facts.push({
      type: "item.upsert",
      agent: parent.key,
      item: tool.key,
      draft: {
        type: "tool_call",
        call: { detail: { kind: "agent.spawn", childAgent: child.key } },
      },
    });
    backgroundChild(state, tool, facts);
  }
  if (type === "subagent_spawned") state.start(child, facts, "spawn");
  const snapshot = object(update["state"]);
  if (status === "running") {
    child.terminal = false;
    state.start(child, facts, "spawn");
  }
  if (association.terminal && !child.terminal) {
    const stop = string(snapshot["stopReason"]);
    const cancelled = status === "cancelled" || stop === "cancelled";
    const classified =
      state.quirks.classifyError(child.segment) ??
      (stop === "refusal"
        ? { kind: "quota" as const, message: "Subagent refused the prompt" }
        : undefined);
    const failed = status === "failed" || classified !== undefined;
    state.start(child, facts, "spawn");
    state.end(
      child,
      facts,
      cancelled ? "interrupted" : failed ? "failed" : "completed",
      failed
        ? (classified ?? { kind: "provider", message: child.segment || "Subagent failed" })
        : undefined,
    );
    child.terminal = true;
    if (tool) state.backgroundTools.delete(tool);
    delete child.cancelAt;
    if (parent.suspended) {
      parent.suspended = false;
      state.start(parent, facts, "subagent_result");
    }
    finishChildTasks(state, child, cancelled ? "stopped" : failed ? "failed" : "completed", facts);
  }
  if (status === "disconnected") {
    facts.push({ type: "agent.disconnected", agent: child.key });
    finishChildTasks(state, child, "unknown", facts);
    state.notice(
      facts,
      frame,
      "subagent_state_update",
      "Child disconnected; completion is unconfirmed",
      child,
    );
  }
  state.notice(facts, frame, string(type), "ACP child association", parent);
  return true;
}
export function placeholderChild(state: TranslationState, tool: ToolState, facts: Fact[]): void {
  if (!tool.child) {
    const id = state.key("placeholder");
    const child = state.agent(id, facts);
    child.spawn = tool.key;
    tool.child = child;
    state.childTools.set(id, tool);
    facts.push({
      type: "agent.seen",
      agent: child.key,
      parent: tool.owner.key,
      spawnedBy: tool.key,
      origin: "provider_subagent",
      fidelity: "placeholder",
      native: { provider: state.quirks.provider },
      cwd: state.cwd,
      name: string(tool.data["title"]),
    });
    facts.push({
      type: "item.upsert",
      agent: tool.owner.key,
      item: tool.key,
      draft: {
        type: "tool_call",
        call: { detail: { kind: "agent.spawn", childAgent: child.key } },
      },
    });
    state.start(child, facts, "spawn");
  }
  if (["succeeded", "failed", "declined", "cancelled"].includes(tool.status)) {
    const child = tool.child;
    if (!child.terminal)
      state.end(
        child,
        facts,
        tool.status === "succeeded"
          ? "completed"
          : tool.status === "cancelled"
            ? "interrupted"
            : "failed",
      );
    child.terminal = true;
  }
}
export function expireChildren(state: TranslationState, now: number): Fact[] {
  const facts: Fact[] = [];
  for (const child of state.agents.values()) {
    if (child.cancelAt === undefined || now < child.cancelAt || child.terminal) continue;
    state.start(child, facts, "spawn");
    state.end(child, facts, "interrupted");
    child.terminal = true;
    delete child.cancelAt;
    finishChildTasks(state, child, "unknown", facts);
    state.notice(
      facts,
      { deadline: now, nativeId: child.nativeId },
      "ace/cancel-timeout",
      "No child cancellation update within 12 seconds",
      child,
    );
  }
  return facts;
}

function finishChildTasks(
  state: TranslationState,
  child: AgentState,
  status: "completed" | "failed" | "stopped" | "unknown",
  facts: Fact[],
): void {
  const tools = state.childBackgroundTools.get(child.nativeId);
  if (!tools) return;
  for (const tool of tools) {
    if (tool.task) facts.push({ type: "background.ended", task: tool.task, status });
    state.backgroundTools.delete(tool);
    if (status !== "unknown" && tool.owner.suspended) {
      tool.owner.suspended = false;
      state.start(tool.owner, facts, "subagent_result");
    }
  }
  if (status !== "unknown") state.childBackgroundTools.delete(child.nativeId);
}
