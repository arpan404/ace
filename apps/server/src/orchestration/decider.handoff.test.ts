import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
} from "@ace/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-05-06T10:00:00.000Z";
const projectId = ProjectId.makeUnsafe("project-handoff");
const sourceThreadId = ThreadId.makeUnsafe("thread-pi");
const destinationThreadId = ThreadId.makeUnsafe("thread-cursor");
const forkThreadId = ThreadId.makeUnsafe("thread-pi-fork");

function readModelWithNestedHandoffSource(): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    projects: [
      {
        id: projectId,
        title: "Handoff Project",
        workspaceRoot: "/tmp/handoff",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: sourceThreadId,
        projectId,
        title: "Pi source",
        modelSelection: {
          provider: "githubCopilot",
          model: "copilot-model",
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        handoff: {
          sourceThreadId: ThreadId.makeUnsafe("thread-github-copilot"),
          fromProvider: "githubCopilot",
          toProvider: "pi",
          mode: "best",
          createdAt: "2026-05-06T09:59:00.000Z",
        },
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        latestProposedPlanSummary: null,
        queuedComposerMessages: [],
        queuedSteerRequest: null,
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
  };
}

function readModelWithForkedThread(): OrchestrationReadModel {
  const readModel = readModelWithNestedHandoffSource();
  const sourceThread = readModel.threads[0]!;
  return {
    ...readModel,
    threads: [
      ...readModel.threads,
      {
        ...sourceThread,
        id: forkThreadId,
        title: "Pi fork",
        modelSelection: {
          provider: "pi",
          model: "pi-model",
        },
        handoff: undefined,
        fork: {
          sourceThreadId,
          createdAt: "2026-05-06T10:01:00.000Z",
        },
      },
    ],
  };
}

describe("decider handoff", () => {
  it("validates nested handoff source provider from the direct handoff edge", async () => {
    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel: readModelWithNestedHandoffSource(),
        command: {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-create-cursor"),
          threadId: destinationThreadId,
          projectId,
          title: "Cursor destination",
          modelSelection: {
            provider: "cursor",
            model: "cursor-model",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          handoff: {
            sourceThreadId,
            fromProvider: "pi",
            toProvider: "cursor",
            mode: "best",
            createdAt: "2026-05-06T10:01:00.000Z",
          },
          createdAt: "2026-05-06T10:01:00.000Z",
        },
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.created");
    expect(event.payload.handoff?.fromProvider).toBe("pi");
    expect(event.payload.handoff?.toProvider).toBe("cursor");
  });

  it("rejects chat forks that change provider", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: readModelWithNestedHandoffSource(),
          command: {
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-thread-create-provider-switch-fork"),
            threadId: destinationThreadId,
            projectId,
            title: "Invalid provider switch fork",
            modelSelection: {
              provider: "cursor",
              model: "cursor-model",
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            fork: {
              sourceThreadId,
              createdAt: "2026-05-06T10:01:00.000Z",
            },
            createdAt: "2026-05-06T10:01:00.000Z",
          },
        }),
      ),
    ).rejects.toThrow("Fork provider 'cursor' does not match source thread provider 'pi'.");
  });

  it("rejects model metadata updates that change a forked thread provider", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: readModelWithForkedThread(),
          command: {
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("cmd-fork-meta-provider-switch"),
            threadId: forkThreadId,
            modelSelection: {
              provider: "cursor",
              model: "cursor-model",
            },
          },
        }),
      ),
    ).rejects.toThrow("Forked thread provider cannot change from 'pi' to 'cursor'.");
  });

  it("rejects turn starts that change a forked thread provider", async () => {
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: readModelWithForkedThread(),
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-fork-turn-provider-switch"),
            threadId: forkThreadId,
            message: {
              messageId: MessageId.makeUnsafe("message-fork-provider-switch"),
              role: "user",
              text: "continue",
              attachments: [],
            },
            modelSelection: {
              provider: "cursor",
              model: "cursor-model",
            },
            createdAt: "2026-05-06T10:02:00.000Z",
          },
        }),
      ),
    ).rejects.toThrow("Forked thread provider cannot change from 'pi' to 'cursor'.");
  });
});
