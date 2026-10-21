import { redactAceApproval } from "./ace-tools.ts";
import {
  BackgroundTaskId,
  InteractionId,
  InteractionRequest,
  type BackgroundTask,
  type EventPayload,
  type Interaction,
} from "@ace/protocol";
import type { Fact } from "./facts.ts";
import { dictionary, type ApplyContext, type ThreadState } from "./state.ts";
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
  const request = redactAceApproval(fact.request);
  if (request !== fact.request)
    fact = { ...fact, request, raw: [{ type: "ace.private-input", data: { redacted: true } }] };
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
    request: InteractionRequest.parse(fact.request),
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
  if (fact.autoReviewed !== undefined) interaction.autoReviewed = fact.autoReviewed;
  refreshInteractionIndex(state, fact.interaction);
  emit(events, {
    type: "interaction.closed",
    interactionId: interaction.id,
    state: fact.state,
    closedAt: ctx.now,
    ...(fact.resolution === undefined ? {} : { resolution: fact.resolution }),
    ...(fact.resolvedBy === undefined ? {} : { resolvedBy: fact.resolvedBy }),
    ...(fact.autoReviewed === undefined ? {} : { autoReviewed: fact.autoReviewed }),
  });
}

export function startBackground(
  state: ThreadState,
  fact: BackgroundStarted,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  if (fact.kind === "shell" && fact.item !== undefined && get(state.items, fact.item)?.complete)
    return;
  const previous = get(state.tasks, fact.task);
  if (previous?.status === "running") {
    refineBackground(state, fact, previous, ctx, events);
    return;
  }
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
    ...(fact.owner ? { owner: fact.owner } : {}),
    title: fact.title,
    status: "running",
    ambient: fact.ambient ?? false,
    ...(fact.internal ? { internal: true as const } : {}),
    stoppable: fact.stoppable,
    startedAt: ctx.now,
    raw: structuredClone(fact.raw ?? []),
    ...(item ? { toolCallId: item.id } : {}),
    ...(child ? { childAgentId: child.agent.id } : {}),
    ...(fact.outputPath === undefined ? {} : { outputPath: fact.outputPath }),
  };
  if (state.uncertainTasks) delete state.uncertainTasks[fact.task];
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

/**
 * Re-announcing running work never restarts it. An adapter that first saw the task without its
 * spawn (Claude lists background work before naming the spawning tool) supplies the owning
 * descendant, child and tool once it knows them.
 */
function refineBackground(
  state: ThreadState,
  fact: BackgroundStarted,
  task: BackgroundTask,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  const record = ensureAgent(state, fact.agent, ctx, events);
  let changed = task.agentId !== record.agent.id;
  task.agentId = record.agent.id;
  if (fact.childAgent !== undefined && task.childAgentId === undefined) {
    task.childAgentId = ensureAgent(state, fact.childAgent, ctx, events).agent.id;
    changed = true;
  }
  const item = fact.item === undefined ? undefined : get(state.items, fact.item);
  if (task.toolCallId === undefined && item?.type === "tool_call") {
    task.toolCallId = item.id;
    item.call.backgroundTaskId = task.id;
    emit(events, { type: "item.updated", item });
    changed = true;
  }
  if (task.outputPath === undefined && fact.outputPath !== undefined) {
    task.outputPath = fact.outputPath;
    changed = true;
  }
  if (!changed) return;
  emit(events, { type: "background_task.started", task: structuredClone(task) });
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
  if (!task) return;
  const uncertain =
    task.status === "unknown" && !!(state.uncertainTasks && get(state.uncertainTasks, fact.task));
  // A task ace lost track of takes later terminal evidence; its end time stays when it was lost.
  const lost = task.status === "unknown" && !uncertain && fact.status !== "unknown";
  if (task.status !== "running" && !uncertain && !lost) return;
  if (fact.uncertain) put((state.uncertainTasks ??= dictionary<true>()), fact.task, true);
  else if (state.uncertainTasks) delete state.uncertainTasks[fact.task];
  const endedAt = lost && task.endedAt !== undefined ? task.endedAt : ctx.now;
  task.status = fact.status;
  task.endedAt = endedAt;
  refreshTaskIndex(state, fact.task);
  emit(events, {
    type: "background_task.updated",
    taskId: task.id,
    status: fact.status,
    endedAt,
  });
}
