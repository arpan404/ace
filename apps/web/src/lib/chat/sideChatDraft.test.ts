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

  it("parses only the Ace-native side-chat command", () => {
    expect(parseAceSideChatCommand(" /side ")).toEqual({ prompt: "" });
    expect(parseAceSideChatCommand("/side inspect provider context")).toEqual({
      prompt: "inspect provider context",
    });
    expect(parseAceSideChatCommand(".side inspect Codex context")).toBeNull();
    expect(parseAceSideChatCommand("/btw inspect Claude context")).toBeNull();
    expect(parseAceSideChatCommand(".btw inspect provider context")).toBeNull();
    expect(parseAceSideChatCommand("btw inspect provider context")).toBeNull();
  });

  it("strips the Ace-native side-chat command from display titles", () => {
    expect(stripAceSideChatCommand("/side inspect provider context")).toBe(
      "inspect provider context",
    );
    expect(stripAceSideChatCommand(".side inspect Codex context")).toBe(
      ".side inspect Codex context",
    );
  });
});
