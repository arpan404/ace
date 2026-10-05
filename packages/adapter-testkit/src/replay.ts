import { apply, createThreadState, type CoreConfig, type Fact } from "@ace/core";
import type { ProviderAdapter } from "@ace/engine-api";
import { applyEvent, createThreadView } from "@ace/projection";
import {
  Event,
  Thread,
  type AgentStatus,
  type InteractionState,
  type Item,
  type ThreadStatus,
  type ThreadView,
} from "@ace/protocol";
import { validateFrames, type Fixture } from "./fixture.ts";

export interface TimelineEntry {
  t: number;
  thread: ThreadStatus;
  /** Adapter-owned native keys, not canonical IDs. */
  agents: Record<string, AgentStatus>;
}
export interface ReplayFinal {
  view: ThreadView;
  thread: ThreadStatus;
  agents: number;
  items: Record<Item["type"], number>;
  interactions: Record<InteractionState, number>;
}
export interface ReplayResult {
  timeline: TimelineEntry[];
  final: ReplayFinal;
}
export interface ReplayOptions {
  createTranslator: ProviderAdapter["createTranslator"];
  fixture: Fixture;
  coreConfig: CoreConfig;
  /** Extra instants to sample, including instants between or after frames. */
  checkpoints?: readonly number[];
  threadId?: string;
  rootKey?: string;
}

/** At each time, frames run in recorded order, then translator.tick, then core tick. */
export function replayFixture(options: ReplayOptions): ReplayResult {
  const { fixture, coreConfig } = options;
  validateFrames(fixture.frames);
  const checkpoints = options.checkpoints ?? [];
  if (checkpoints.some((t) => !Number.isSafeInteger(t) || t < 0))
    throw new Error("checkpoint times must be nonnegative integers");
  const thread = Thread.parse({
    id: options.threadId ?? "replay-thread",
    workspaceId: "replay-workspace",
    provider: coreConfig.provider,
    title: fixture.header.scenario,
    status: { state: "new" },
    createdAt: 0,
    updatedAt: 0,
  });
  const state = createThreadState({ threadId: thread.id, config: coreConfig });
  const translator = options.createTranslator({
    threadId: thread.id,
    rootKey: options.rootKey ?? "root",
  });
  const view = createThreadView(thread);
  let id = 0;
  let seq = 0;
  const ids = { next: (kind: string) => `${kind}-${++id}` };
  const timeline: TimelineEntry[] = [];
  const times = [...new Set([...fixture.frames.map((frame) => frame.t), ...checkpoints])].toSorted(
    (a, b) => a - b,
  );
  let frameIndex = 0;
  function fold(facts: Fact[], t: number): void {
    for (const fact of facts) {
      for (const payload of apply(state, fact, { now: t, ids })) {
        const event = Event.parse({
          id: `event-${++seq}`,
          seq,
          at: t,
          threadId: thread.id,
          payload,
        });
        applyEvent(view, event);
      }
    }
  }
  for (const t of times) {
    let frame = fixture.frames[frameIndex];
    while (frame?.t === t) {
      fold(translator.translate(structuredClone(frame), t), t);
      frame = fixture.frames[++frameIndex];
    }
    fold(translator.tick(t), t);
    fold([{ type: "tick" }], t);
    timeline.push({
      t,
      thread: structuredClone(view.thread.status),
      agents: Object.fromEntries(
        Object.entries(state.agents).map(([key, record]) => {
          const agent = view.agents[record.agent.id];
          if (!agent) throw new Error(`projection is missing agent ${record.agent.id}`);
          return [key, structuredClone(agent.status)];
        }),
      ),
    });
  }
  const items: ReplayFinal["items"] = {
    "delegation.started": 0,
    "delegation.settled": 0,
    message: 0,
    reasoning: 0,
    tool_call: 0,
    notice: 0,
    compaction: 0,
    artifact: 0,
  };
  const interactions: ReplayFinal["interactions"] = {
    pending: 0,
    resolved: 0,
    cancelled: 0,
    expired: 0,
  };
  for (const item of Object.values(view.items)) items[item.type]++;
  for (const interaction of Object.values(view.interactions)) interactions[interaction.state]++;
  return {
    timeline,
    final: {
      view,
      thread: structuredClone(view.thread.status),
      agents: Object.keys(view.agents).length,
      items,
      interactions,
    },
  };
}
