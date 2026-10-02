import { z } from "zod";
import { extendsOutput } from "./output-snapshot.ts";
import {
  Agent,
  AgentActivity,
  AgentId,
  AgentStatus,
  BackgroundTask,
  DeviceId,
  EventPayload,
  InteractionRequest,
  InteractionResolution,
  Item,
  ItemId,
  NativeRef,
  RawPayload,
  RunTrigger,
  Timestamp,
} from "@ace/protocol";
import type { Fact, ItemDraft, ToolDetailDraft } from "./facts.ts";
import { get } from "./emit.ts";
import { itemDetailKind, itemInput } from "./item-input.ts";
import type { ThreadState } from "./state.ts";
import { isFactData, preservesFields, validData } from "./fact-data.ts";

type Fields = Record<string, unknown>;
const raw = RawPayload.array();
const agentId = AgentId.parse("validation_agent");
const itemId = ItemId.parse("validation_item");
const allowed: Record<Fact["type"], string[]> = {
  "agent.seen": [
    "agent",
    "parent",
    "spawnedBy",
    "origin",
    "fidelity",
    "native",
    "cwd",
    "name",
    "role",
    "model",
    "background",
  ],
  "agent.linked": ["agent", "parent", "spawnedBy", "background", "name", "model"],
  "turn.started": ["agent", "nativeTurnId", "trigger"],
  "turn.ended": ["agent", "nativeTurnId", "outcome", "trigger", "error"],
  activity: ["agent", "activity", "detail"],
  "item.upsert": ["agent", "item", "draft"],
  "item.reconciled": ["agent", "item", "draft"],
  "subagents.waiting": ["agent", "item", "targets"],
  "item.delta": ["agent", "item", "field", "append"],
  "interaction.opened": ["agent", "interaction", "blocking", "request", "item", "raw"],
  "interaction.closed": ["interaction", "state", "resolution", "resolvedBy"],
  "background.started": [
    "agent",
    "task",
    "kind",
    "title",
    "item",
    "childAgent",
    "ambient",
    "stoppable",
    "outputPath",
    "raw",
  ],
  "background.ended": ["task", "status", "uncertain"],
  "agent.disconnected": ["agent"],
  "agent.reconnected": ["agent"],
  retry: ["agent", "on", "attempt", "until", "message"],
  "retry.cleared": ["agent"],
  "wake.expected": ["agent", "until"],
  usage: ["agent", "inputTokens", "outputTokens", "cachedInputTokens", "contextWindow", "costUsd"],
  signal: ["agent"],
  "process.exited": ["deliberate", "message"],
  "process.started": [],
  "queue.changed": ["count", "source"],
  tick: [],
};

function object(value: unknown): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const optionalBoolean = (value: unknown) => value === undefined || typeof value === "boolean";
const oneOf = (value: unknown, values: string[]) =>
  typeof value === "string" && values.includes(value);

function relationError(state: ThreadState, agent: string, parent: string): string | undefined {
  const record = get(state.agents, agent);
  if (parent === agent) return "an agent cannot be its own parent";
  if (state.initialRoot?.agent === agent) return "a configured root cannot be re-parented";
  if (
    state.rootKey === agent &&
    record?.agent.origin === "root" &&
    record.agent.fidelity !== "placeholder"
  )
    return "a known root cannot be re-parented";
  const visited = new Set<string>();
  let key: string | undefined = parent;
  while (key !== undefined && !visited.has(key)) {
    if (key === agent) return "agent links cannot create a cycle";
    visited.add(key);
    key = get(state.agents, key)?.parentKey;
  }
  return undefined;
}

function detailCandidate(draft: ToolDetailDraft) {
  if (draft.kind === "agent.spawn") {
    const { childAgent, ...detail } = draft;
    return { ...detail, ...(childAgent === undefined ? {} : { childAgentId: agentId }) };
  }
  if (draft.kind === "agent.message") {
    const { targetAgent, ...detail } = draft;
    return { ...detail, ...(targetAgent === undefined ? {} : { targetAgentId: agentId }) };
  }
  return draft;
}

function itemError(state: ThreadState, fact: Fields, now: number): string | undefined {
  if (!object(fact.draft)) return "item draft must be an object";
  if (
    ["id", "agentId", "runId", "createdAt"].some((field) =>
      Object.hasOwn(fact.draft as Fields, field),
    )
  )
    return "item identity and creation time belong to core";
  const previous = get(state.items, fact.item as string);
  const owner = get(state.agents, fact.agent as string);
  if (previous && previous.agentId !== owner?.agent.id) return "item key has a different owner";
  const draft = fact.draft as ItemDraft;
  if (draft.type === "tool_call" && draft.call !== undefined && !object(draft.call))
    return "tool draft must be an object";
  if (
    draft.type === "tool_call" &&
    draft.call &&
    ["id", "agentId", "backgroundTaskId"].some((field) => Object.hasOwn(draft.call!, field))
  )
    return "tool identities belong to core";
  const detail = draft.type === "tool_call" ? draft.call?.detail : undefined;
  if (detail !== undefined && !object(detail)) return "tool detail must be an object";
  if (detail && ["childAgentId", "targetAgentId"].some((field) => Object.hasOwn(detail, field)))
    return "tool agent references must use native keys";
  if (detail && "output" in detail && !optionalString(detail.output))
    return "output summaries belong to core; adapters append output deltas";
  if (detail?.kind === "agent.spawn" && detail.childAgent !== undefined) {
    if (typeof detail.childAgent !== "string") return "child agent key must be a string";
    const error = relationError(state, detail.childAgent, fact.agent as string);
    if (error) return error;
  }
  if (detail?.kind === "agent.message" && !optionalString(detail.targetAgent))
    return "target agent key must be a string";
  if (
    itemDetailKind(previous, draft) === "shell" &&
    detail &&
    "output" in detail &&
    typeof detail.output === "string" &&
    previous?.type === "tool_call" &&
    previous.call.detail.kind === "shell"
  ) {
    if (
      fact.type !== "item.reconciled" &&
      !extendsOutput(previous.call.detail.output, detail.output)
    )
      return "legacy output must extend the existing stream";
  }
  const input = itemInput(
    previous,
    {
      id: previous?.id ?? itemId,
      agentId: owner?.agent.id ?? agentId,
      createdAt: previous?.createdAt ?? now,
    },
    draft,
    now,
    detail === undefined ? undefined : detailCandidate(detail),
  );
  const result = Item.safeParse(input);
  if (!result.success) return "item draft does not form a valid canonical item";
  if (!preservesFields(input, result.data))
    return "unknown item fields must be retained as raw data";
  if (result.data.type === "tool_call" && result.data.call.kind !== result.data.call.detail.kind)
    return "tool kind contradicts its detail";
  if (result.data.type === "tool_call" && result.data.call.detail.kind === "agent.spawn") {
    const key = fact.item as string;
    const children = new Set(
      Object.keys(get(state.indexes.pendingSpawnLinks, key) ?? {}).filter(
        (child) => get(state.agents, child)?.spawnedByKey === key,
      ),
    );
    const linked = get(state.itemLinks, key)?.childAgent;
    if (linked !== undefined) children.add(linked);
    for (const child of children) {
      const error = relationError(state, child, fact.agent as string);
      if (error) return error;
    }
  }
  return undefined;
}

function shapeValid(state: ThreadState, fact: Fields, type: Fact["type"], now: number): boolean {
  switch (type) {
    case "agent.seen":
      return (
        Agent.safeParse({
          ...fact,
          id: agentId,
          threadId: state.threadId,
          parentId: null,
          status: { state: "starting" },
          createdAt: now,
          background: fact.background ?? false,
        }).success && validData(NativeRef, fact.native)
      );
    case "agent.linked":
      return (
        optionalBoolean(fact.background) && optionalString(fact.name) && optionalString(fact.model)
      );
    case "turn.started":
      return RunTrigger.safeParse(fact.trigger).success;
    case "turn.ended":
      return (
        oneOf(fact.outcome, ["completed", "failed", "interrupted"]) &&
        (fact.trigger === undefined || RunTrigger.safeParse(fact.trigger).success) &&
        (fact.error === undefined || validData(AgentStatus, { state: "failed", error: fact.error }))
      );
    case "activity":
      return AgentActivity.safeParse(fact.activity).success && optionalString(fact.detail);
    case "subagents.waiting":
      return z.array(z.string()).safeParse(fact.targets).success;
    case "item.reconciled":
    case "item.upsert":
      return itemError(state, fact, now) === undefined;
    case "item.delta":
      return oneOf(fact.field, ["text", "reasoning", "output"]) && typeof fact.append === "string";
    case "interaction.opened":
      return (
        typeof fact.blocking === "boolean" &&
        validData(InteractionRequest, fact.request) &&
        (fact.raw === undefined || validData(raw, fact.raw))
      );
    case "interaction.closed":
      return (
        oneOf(fact.state, ["resolved", "cancelled", "expired"]) &&
        (fact.resolution === undefined || validData(InteractionResolution, fact.resolution)) &&
        (fact.resolvedBy === undefined || DeviceId.safeParse(fact.resolvedBy).success)
      );
    case "background.started":
      return (
        BackgroundTask.shape.kind.safeParse(fact.kind).success &&
        typeof fact.title === "string" &&
        typeof fact.stoppable === "boolean" &&
        optionalBoolean(fact.ambient) &&
        optionalString(fact.outputPath) &&
        (fact.raw === undefined || validData(raw, fact.raw))
      );
    case "background.ended":
      return (
        oneOf(fact.status, ["completed", "failed", "stopped", "unknown"]) &&
        optionalBoolean(fact.uncertain) &&
        (fact.uncertain !== true || fact.status === "unknown")
      );
    case "retry":
      return (
        oneOf(fact.on, ["rate_limit", "network", "upstream"]) &&
        AgentStatus.safeParse({ ...fact, state: "blocked", refs: [] }).success
      );
    case "wake.expected":
      return Timestamp.safeParse(fact.until).success;
    case "usage":
      return EventPayload.safeParse({ ...fact, type: "usage.updated", agentId }).success;
    case "process.exited":
      return typeof fact.deliberate === "boolean" && optionalString(fact.message);
    case "queue.changed":
      return (
        typeof fact.count === "number" &&
        Number.isSafeInteger(fact.count) &&
        fact.count >= 0 &&
        (fact.source === undefined || oneOf(fact.source, ["engine", "provider"]))
      );
    case "agent.disconnected":
    case "agent.reconnected":
    case "retry.cleared":
    case "signal":
    case "tick":
    case "process.started":
      return true;
  }
}

/** Preflight only reads state. No ids, signals, rows or indexes are changed. */
function checkedFact(
  state: ThreadState,
  input: unknown,
  now: number,
): { fact: Fact } | { error: string } {
  if (!isFactData(input)) return { error: "adapter facts must contain JSON data" };
  if (!object(input) || typeof input.type !== "string" || !Object.hasOwn(allowed, input.type))
    return { error: "unknown adapter fact" };
  const type = input.type as Fact["type"];
  const fields = allowed[type];
  if (Object.keys(input).some((key) => key !== "type" && !fields.includes(key)))
    return { error: "unrecognized fact fields" };
  for (const key of ["parent", "spawnedBy", "nativeTurnId", "item", "childAgent"]) {
    if (fields.includes(key) && !optionalString(input[key]))
      return { error: `${key} must be a string` };
  }
  if (
    fields.includes("agent") &&
    (type === "signal" ? !optionalString(input.agent) : typeof input.agent !== "string")
  )
    return { error: "agent key must be a string" };
  for (const key of ["interaction", "task"])
    if (fields.includes(key) && typeof input[key] !== "string")
      return { error: `${key} key must be a string` };
  if (
    (type === "item.upsert" ||
      type === "item.reconciled" ||
      type === "item.delta" ||
      type === "subagents.waiting") &&
    typeof input.item !== "string"
  )
    return { error: "item key must be a string" };
  if (type === "agent.seen" || type === "agent.linked") {
    if (type === "agent.seen" && input.origin === "root" && input.parent !== undefined)
      return { error: "a root cannot have a parent" };
    if (typeof input.parent === "string") {
      const error = relationError(state, input.agent as string, input.parent);
      if (error) return { error };
    }
    if (typeof input.spawnedBy === "string") {
      const item = get(state.items, input.spawnedBy);
      const owner = item?.agentId && get(state.indexes.agentKeysById, item.agentId);
      if (owner !== undefined) {
        const error = relationError(state, input.agent as string, owner);
        if (error) return { error };
        if (input.parent !== undefined && input.parent !== owner)
          return { error: "spawn owner contradicts the parent" };
      }
    }
  }
  if (type === "item.delta") {
    const item = get(state.items, input.item as string);
    if (item && item.agentId !== get(state.agents, input.agent as string)?.agent.id)
      return { error: "item key has a different owner" };
    if (
      item &&
      !(
        (input.field === "output" &&
          item.type === "tool_call" &&
          item.call.detail.kind === "shell") ||
        (input.field === "text" && item.type === "message") ||
        (input.field !== "output" && (item.type === "reasoning" || item.type === "notice"))
      )
    )
      return { error: "delta field contradicts its item" };
  }
  if (
    (type === "background.started" ||
      type === "interaction.opened" ||
      type === "subagents.waiting") &&
    typeof input.item === "string"
  ) {
    const item = get(state.items, input.item);
    if (item && item.agentId !== get(state.agents, input.agent as string)?.agent.id)
      return { error: "referenced item has a different owner" };
    if (item && item.type !== "tool_call") return { error: "work links must reference a tool" };
    if (type === "subagents.waiting" && !item)
      return { error: "wait must reference an existing tool" };
  }
  if (type === "interaction.opened" || type === "background.started") {
    const current =
      type === "interaction.opened"
        ? get(state.interactions, input.interaction as string)
        : get(state.tasks, input.task as string);
    const live =
      current && ("state" in current ? current.state === "pending" : current.status === "running");
    if (live && current.agentId !== get(state.agents, input.agent as string)?.agent.id)
      return { error: "live key has a different owner" };
  }
  if (type === "interaction.closed" && object(input.resolution)) {
    const current = get(state.interactions, input.interaction as string);
    if (current && current.request.kind !== input.resolution.kind)
      return { error: "resolution contradicts its request" };
  }
  if (type === "background.started" && typeof input.childAgent === "string") {
    const error = relationError(state, input.childAgent, input.agent as string);
    if (error) return { error };
  }
  try {
    if (!shapeValid(state, input, type, now)) return { error: "invalid adapter fact fields" };
  } catch {
    return { error: "invalid adapter fact data" };
  }
  return { fact: input as Fact };
}

export function validateFact(
  state: ThreadState,
  input: unknown,
  now: number,
): { fact: Fact } | { error: string } {
  try {
    return checkedFact(state, input, now);
  } catch {
    return { error: "invalid adapter fact data" };
  }
}
