import { describe, expect, it } from "vitest";

import { isAceSideConversationThreadId } from "./sideConversation.ts";

describe("sideConversation", () => {
  it("recognizes only Ace side-chat ids scoped to the parent thread", () => {
    expect(isAceSideConversationThreadId("side:thread-1:question-1", "thread-1")).toBe(true);
    expect(isAceSideConversationThreadId("side:thread-2:question-1", "thread-1")).toBe(false);
    expect(isAceSideConversationThreadId("side:provider-child", "thread-1")).toBe(false);
    expect(isAceSideConversationThreadId("provider-child", "thread-1")).toBe(false);
  });

  it("keeps the legacy shape check for callers without a parent thread id", () => {
    expect(isAceSideConversationThreadId("side:thread-1:question-1")).toBe(true);
    expect(isAceSideConversationThreadId("side:provider-child")).toBe(false);
  });
});
