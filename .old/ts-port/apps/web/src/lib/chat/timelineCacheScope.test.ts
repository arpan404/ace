import { MessageId, ThreadId, TurnId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic/types";
import type { ChatMessage, Thread } from "../../types";
import {
  appendChatMessageStreamingTextState,
  createChatMessageStreamingTextState,
} from "./messageText";
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

function makeStreamingScope(text: string): string | null {
  const state = appendChatMessageStreamingTextState(
    createChatMessageStreamingTextState("Start"),
    text,
  );
  const message = {
    id: MessageId.makeUnsafe("message-cache-scope"),
    role: "assistant",
    text: "",
    streamingTextState: state,
    createdAt: "2026-03-17T19:12:30.000Z",
    streaming: true,
  } satisfies ChatMessage;
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

function makeWorkScope(turnId: string): string | null {
  const workEntry = {
    id: "work-cache-scope",
    createdAt: "2026-03-17T19:12:31.000Z",
    turnId: TurnId.makeUnsafe(turnId),
    label: "Run command",
    status: "completed",
    tone: "tool",
  } satisfies WorkLogEntry;
  const timelineEntry = {
    id: workEntry.id,
    kind: "work",
    createdAt: workEntry.createdAt,
    entry: workEntry,
  } satisfies TimelineEntry;

  return buildThreadTimelineCacheScope({
    thread: baseThread,
    timelineEntries: [timelineEntry],
    timelineMessages: [],
    timelineProposedPlans: [],
    timelineWorkEntries: [workEntry],
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

  it("changes when streaming message content changes", () => {
    expect(makeStreamingScope(" the work.")).not.toBe(makeStreamingScope(" the work with tests."));
  });

  it("changes when tail work turn ownership changes", () => {
    expect(makeWorkScope("turn-cache-scope-a")).not.toBe(makeWorkScope("turn-cache-scope-b"));
  });
});
