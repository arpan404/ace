import {
  BackgroundTaskId,
  InteractionId,
  type BackgroundTask,
  type EventPayload,
  type Interaction,
} from "@ace/protocol";
import type { Fact } from "./facts.ts";
import type { ApplyContext, ThreadState } from "./state.ts";
import { emit, get, put } from "./emit.ts";
import { ensureAgent, linkAgent } from "./tree.ts";
import { upsertItem } from "./items.ts";
import { refreshInteractionIndex, refreshTaskIndex } from "./indexes.ts";

type Opened = Extract<Fact, { type: "interaction.opened" }>;
type Closed = Extract<Fact, { type: "interaction.closed" }>;
type BackgroundStarted = Extract<Fact, { type: "background.started" }>;

export function openInteraction(
  state: ThreadState,
  fact: Opened,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  const previous = get(state.interactions, fact.interaction);
  if (previous?.state === "pending") return;
  if (previous) put(state.interactionHistory, previous.id, structuredClone(previous));
  const record = ensureAgent(state, fact.agent, ctx, events);
  const item =
    fact.item === undefined
      ? undefined
      : (get(state.items, fact.item) ??
        upsertItem(
          state,
          fact.agent,
          fact.item,
          {
            type: "tool_call",
            call: {
              kind: "ask_user",
              title: "Awaiting input",
              status: "awaiting_approval",
              detail: { kind: "ask_user" },
            },
          },
          ctx,
          events,
        ));
  const interaction: Interaction = {
    id: InteractionId.parse(ctx.ids.next("interaction")),
    threadId: state.threadId,
    agentId: record.agent.id,
    blocking: fact.blocking,
    request: structuredClone(fact.request),
    state: "pending",
    createdAt: ctx.now,
    raw: structuredClone(fact.raw ?? []),
    ...(item ? { toolCallId: item.id } : {}),
  };
  put(state.interactions, fact.interaction, interaction);
  refreshInteractionIndex(state, fact.interaction);
  emit(events, { type: "interaction.opened", interaction });
}

export function closeInteraction(
  state: ThreadState,
  fact: Closed,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  const interaction = get(state.interactions, fact.interaction);
  if (!interaction || interaction.state !== "pending") return;
  interaction.state = fact.state;
  interaction.closedAt = ctx.now;
  if (fact.resolution !== undefined) interaction.resolution = structuredClone(fact.resolution);
  if (fact.resolvedBy !== undefined) interaction.resolvedBy = fact.resolvedBy;
  refreshInteractionIndex(state, fact.interaction);
  emit(events, {
    type: "interaction.closed",
    interactionId: interaction.id,
    state: fact.state,
    closedAt: ctx.now,
    ...(fact.resolution === undefined ? {} : { resolution: fact.resolution }),
    ...(fact.resolvedBy === undefined ? {} : { resolvedBy: fact.resolvedBy }),
  });
}

export function startBackground(
  state: ThreadState,
  fact: BackgroundStarted,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  const previous = get(state.tasks, fact.task);
  if (previous?.status === "running") return;
  if (previous) put(state.taskHistory, previous.id, structuredClone(previous));
  const record = ensureAgent(state, fact.agent, ctx, events);
  const child =
    fact.childAgent === undefined ? undefined : ensureAgent(state, fact.childAgent, ctx, events);
  const item =
    fact.item === undefined
      ? undefined
      : (get(state.items, fact.item) ??
        upsertItem(
          state,
          fact.agent,
          fact.item,
          {
            type: "tool_call",
            call: {
              title: fact.title,
              status: "running",
              ...(fact.kind === "shell"
                ? { kind: "shell", detail: { kind: "shell", command: "" } }
                : child
                  ? {
                      kind: "agent.spawn",
                      detail: {
                        kind: "agent.spawn",
                        ...(fact.childAgent === undefined ? {} : { childAgent: fact.childAgent }),
                      },
                    }
                  : { kind: "custom", detail: { kind: "custom" } }),
            },
          },
          ctx,
          events,
        ));
  const task: BackgroundTask = {
    id: BackgroundTaskId.parse(ctx.ids.next("task")),
    agentId: record.agent.id,
    kind: fact.kind,
    title: fact.title,
    status: "running",
    ambient: fact.ambient ?? false,
    stoppable: fact.stoppable,
    startedAt: ctx.now,
    raw: structuredClone(fact.raw ?? []),
    ...(item ? { toolCallId: item.id } : {}),
    ...(child ? { childAgentId: child.agent.id } : {}),
    ...(fact.outputPath === undefined ? {} : { outputPath: fact.outputPath }),
  };
  put(state.tasks, fact.task, task);
  refreshTaskIndex(state, fact.task);
  emit(events, { type: "background_task.started", task });
  if (item?.type === "tool_call") {
    item.call.backgroundTaskId = task.id;
    emit(events, { type: "item.updated", item });
  }
  if (fact.childAgent !== undefined)
    linkAgent(
      state,
      {
        type: "agent.linked",
        agent: fact.childAgent,
        parent: fact.agent,
        ...(fact.item === undefined ? {} : { spawnedBy: fact.item }),
      },
      ctx,
      events,
    );
}

export function endBackground(
  state: ThreadState,
  fact: Extract<Fact, { type: "background.ended" }>,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  const task = get(state.tasks, fact.task);
  if (!task || task.status !== "running") return;
  task.status = fact.status;
  task.endedAt = ctx.now;
  refreshTaskIndex(state, fact.task);
  emit(events, {
    type: "background_task.updated",
    taskId: task.id,
    status: fact.status,
    endedAt: ctx.now,
  });
}
