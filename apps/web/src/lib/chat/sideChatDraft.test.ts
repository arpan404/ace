import { ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  NEW_SIDE_CHAT_DRAFT_RUNTIME_MODE,
  NEW_SIDE_CHAT_THREAD_ID,
  newSideChatDraftThreadId,
} from "./sideChatDraft";

describe("sideChatDraft", () => {
  it("builds the Ace-native new side-chat draft identity", () => {
    expect(
      newSideChatDraftThreadId({
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
      }),
    ).toBe(`subagent:thread-1:${NEW_SIDE_CHAT_THREAD_ID}`);
  });

  it("defaults new Ace side-chat drafts to approval-required mode", () => {
    expect(NEW_SIDE_CHAT_DRAFT_RUNTIME_MODE).toBe("approval-required");
  });
});
