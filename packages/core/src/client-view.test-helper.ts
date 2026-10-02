import { applyDelta } from "@ace/projection";
import type {
  Agent,
  BackgroundTask,
  EventPayload,
  Interaction,
  Item,
  Run,
  ThreadStatus,
} from "@ace/protocol";
import { expect } from "vitest";
import type { ThreadState } from "./index.ts";

/** A client only receives payloads; native adapter keys never enter these tables. */
export interface ClientView {
  agents: Record<string, Agent>;
  items: Record<string, Item>;
  interactions: Record<string, Interaction>;
  tasks: Record<string, BackgroundTask>;
  runs: Record<string, Run>;
  status: ThreadStatus;
}
export function createClientView(): ClientView {
  return {
    agents: Object.create(null) as ClientView["agents"],
    items: Object.create(null) as ClientView["items"],
    interactions: Object.create(null) as ClientView["interactions"],
    tasks: Object.create(null) as ClientView["tasks"],
    runs: Object.create(null) as ClientView["runs"],
    status: { state: "new" },
  };
}

export function foldPayload(view: ClientView, payload: EventPayload): void {
  const event = structuredClone(payload);
  switch (event.type) {
    case "agent.created":
      view.agents[event.agent.id] = event.agent;
      break;
    case "agent.updated": {
      const { type: _type, agentId, ...patch } = event;
      Object.assign(view.agents[agentId]!, patch);
      break;
    }
    case "agent.status":
      view.agents[event.agentId]!.status = event.status;
      break;
    case "item.created":
    case "item.updated":
      view.items[event.item.id] = event.item;
      break;
    case "item.delta": {
      const item = view.items[event.itemId]!;
      applyDelta(item, event.field, event.append);
      break;
    }
    case "interaction.opened":
      view.interactions[event.interaction.id] = event.interaction;
      break;
    case "interaction.closed": {
      const { type: _type, interactionId, ...patch } = event;
      Object.assign(view.interactions[interactionId]!, patch);
      break;
    }
    case "background_task.started":
      view.tasks[event.task.id] = event.task;
      break;
    case "background_task.updated": {
      const { type: _type, taskId, ...patch } = event;
      Object.assign(view.tasks[taskId]!, patch);
      break;
    }
    case "run.started":
      view.runs[event.run.id] = event.run;
      break;
    case "run.ended": {
      const { type: _type, runId, ...patch } = event;
      Object.assign(view.runs[runId]!, patch);
      break;
    }
    case "thread.created":
      view.status = event.thread.status;
      break;
    case "thread.updated":
      if (event.status) view.status = event.status;
      break;
    case "usage.updated":
      break;
  }
}

function byId<T extends { id: string }>(rows: T[]): Record<string, T> {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

/** The snapshot must be recoverable from the emitted event log after every fact. */
export function assertClientMatchesState(view: ClientView, state: ThreadState): void {
  expect(view.agents).toEqual(byId(Object.values(state.agents).map((record) => record.agent)));
  expect(view.items).toEqual(byId(Object.values(state.items)));
  expect(view.interactions).toEqual(
    byId([...Object.values(state.interactionHistory), ...Object.values(state.interactions)]),
  );
  expect(view.tasks).toEqual(
    byId([...Object.values(state.taskHistory), ...Object.values(state.tasks)]),
  );
  expect(view.runs).toEqual(byId(Object.values(state.runs)));
  expect(view.status).toEqual(state.status);
}
