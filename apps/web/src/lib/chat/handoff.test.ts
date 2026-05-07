import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type ProviderKind,
} from "@ace/contracts";
import { describe, expect, it } from "vitest";

import type { Thread } from "../../types";
import { buildHandoffTimeline, resolveHandoffLineage } from "./handoff";

const now = "2026-05-06T10:00:00.000Z";
const projectId = ProjectId.makeUnsafe("project-handoff");

function thread(input: {
  id: string;
  provider: ProviderKind;
  title: string;
  text: string;
  createdAt: string;
  handoff?: Thread["handoff"];
}): Thread {
  return {
    id: ThreadId.makeUnsafe(input.id),
    codexThreadId: null,
    projectId,
    title: input.title,
    modelSelection: {
      provider: input.provider,
      model: `${input.provider}-model`,
    },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    session: null,
    messages: [
      {
        id: MessageId.makeUnsafe(`message-${input.id}`),
        role: "assistant",
        text: input.text,
        createdAt: input.createdAt,
        streaming: false,
      },
    ],
    proposedPlans: [],
    error: null,
    createdAt: input.createdAt,
    archivedAt: null,
    updatedAt: input.createdAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...(input.handoff ? { handoff: input.handoff } : {}),
    historyLoaded: true,
    latestProposedPlanSummary: null,
    queuedComposerMessages: [],
    queuedSteerRequest: null,
    turnDiffSummaries: [],
    activities: [],
  };
}

describe("handoff timeline", () => {
  it("labels chained handoffs from the immediate previous provider", () => {
    const copilot = thread({
      id: "thread-github-copilot",
      provider: "githubCopilot",
      title: "Copilot",
      text: "copilot work",
      createdAt: now,
    });
    const pi = thread({
      id: "thread-pi",
      provider: "pi",
      title: "Pi",
      text: "pi work",
      createdAt: "2026-05-06T10:01:00.000Z",
      handoff: {
        sourceThreadId: copilot.id,
        fromProvider: "githubCopilot",
        toProvider: "pi",
        mode: "best",
        createdAt: "2026-05-06T10:01:00.000Z",
      },
    });
    const cursor = thread({
      id: "thread-cursor",
      provider: "cursor",
      title: "Cursor",
      text: "cursor work",
      createdAt: "2026-05-06T10:02:00.000Z",
      handoff: {
        sourceThreadId: pi.id,
        fromProvider: "githubCopilot",
        toProvider: "cursor",
        mode: "best",
        createdAt: "2026-05-06T10:02:00.000Z",
      },
    });

    const timeline = buildHandoffTimeline({
      activeThread: cursor,
      activeThreadMessages: cursor.messages,
      activeThreadWorkEntries: [],
      handoffLineage: resolveHandoffLineage({
        sourceThreadId: cursor.handoff!.sourceThreadId,
        threads: [copilot, pi, cursor],
      }),
    });

    expect(timeline.messages.map((message) => message.text)).toEqual([
      "copilot work",
      "Handoff from Copilot to Pi",
      "pi work",
      "Handoff from Pi to Cursor",
      "cursor work",
    ]);
  });
});
