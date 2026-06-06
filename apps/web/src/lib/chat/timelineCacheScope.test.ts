import { MessageId, ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../session-logic/types";
import type { ChatMessage, Thread } from "../../types";
import { buildThreadTimelineCacheScope } from "./timelineCacheScope";

const baseThread = {
  id: ThreadId.makeUnsafe("thread-cache-scope"),
  historyLoaded: true,
  latestTurn: null,
  modelSelection: {
    provider: "codex",
    model: "gpt-5",
  },
  session: null,
  updatedAt: "2026-03-17T19:12:30.000Z",
} satisfies Pick<
  Thread,
  "id" | "historyLoaded" | "latestTurn" | "modelSelection" | "session" | "updatedAt"
>;

function makeMessage(text: string): ChatMessage {
  return {
    id: MessageId.makeUnsafe("message-cache-scope"),
    role: "user",
    text,
    createdAt: "2026-03-17T19:12:30.000Z",
    streaming: false,
  };
}

function makeScope(text: string): string | null {
  const message = makeMessage(text);
  const timelineEntry = {
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  } satisfies TimelineEntry;

  return buildThreadTimelineCacheScope({
    thread: baseThread,
    timelineEntries: [timelineEntry],
    timelineMessages: [message],
    timelineProposedPlans: [],
    timelineWorkEntries: [],
    turnDiffSummaries: [],
  });
}

describe("buildThreadTimelineCacheScope", () => {
  it("is stable across equivalent remounted timeline arrays", () => {
    expect(makeScope("Start the work.")).toBe(makeScope("Start the work."));
  });

  it("changes when tail message content changes", () => {
    expect(makeScope("Start the work.")).not.toBe(makeScope("Start the work with tests."));
  });
});
