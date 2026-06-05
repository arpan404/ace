import { ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  NEW_SIDE_CHAT_DRAFT_RUNTIME_MODE,
  NEW_SIDE_CHAT_THREAD_ID,
  newSideChatDraftThreadId,
  parseAceSideChatCommand,
  stripAceSideChatCommand,
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

  it("parses Ace-native side-chat commands and hidden provider aliases", () => {
    expect(parseAceSideChatCommand(" /side ")).toEqual({ prompt: "" });
    expect(parseAceSideChatCommand(".side inspect Codex context")).toEqual({
      prompt: "inspect Codex context",
    });
    expect(parseAceSideChatCommand("/btw inspect Claude context")).toEqual({
      prompt: "inspect Claude context",
    });
    expect(parseAceSideChatCommand(".btw inspect provider context")).toEqual({
      prompt: "inspect provider context",
    });
  });

  it("does not treat natural language btw as a side-chat command", () => {
    expect(parseAceSideChatCommand("btw inspect provider context")).toBeNull();
  });

  it("strips side-chat command aliases from display titles", () => {
    expect(stripAceSideChatCommand(".side inspect Codex context")).toBe("inspect Codex context");
    expect(stripAceSideChatCommand("/btw inspect Claude context")).toBe("inspect Claude context");
  });
});
