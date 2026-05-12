import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
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
});
