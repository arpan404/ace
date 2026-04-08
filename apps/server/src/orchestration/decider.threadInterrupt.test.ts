import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@ace/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

describe("decider thread interrupts", () => {
  it("fills the active turn id when interrupt commands omit it", async () => {
    const now = new Date().toISOString();
    const initial = createEmptyReadModel(now);

    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const withThread = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: asThreadId("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: asThreadId("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const readModel = await Effect.runPromise(
      projectEvent(withThread, {
        sequence: 3,
        eventId: asEventId("evt-thread-session-set"),
        aggregateKind: "thread",
        aggregateId: asThreadId("thread-1"),
        type: "thread.session-set",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-session-set"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-session-set"),
        metadata: {},
        payload: {
          threadId: asThreadId("thread-1"),
          session: {
            threadId: asThreadId("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: now,
          },
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe("cmd-thread-turn-interrupt"),
          threadId: asThreadId("thread-1"),
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event).toBeDefined();
    if (!event) {
      return;
    }

    expect(event.type).toBe("thread.turn-interrupt-requested");
    expect(event.payload).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: now,
    });
  });
});
