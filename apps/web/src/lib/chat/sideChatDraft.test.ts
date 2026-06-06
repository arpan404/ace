import { ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  NEW_SIDE_CHAT_DRAFT_RUNTIME_MODE,
  NEW_SIDE_CHAT_THREAD_ID,
  newSideChatDraftThreadId,
  normalizeAceSideChatPromptText,
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
    expect(
      parseAceSideChatCommand(
        "/side Review the current provider context./sideReview the current provider context./sideReview the current provider context.",
      ),
    ).toEqual({
      prompt: "Review the current provider context.",
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

  it("normalizes dirty Ace side-chat prompt drafts without enabling provider aliases", () => {
    expect(
      normalizeAceSideChatPromptText(
        "Review the current provider context./sideReview the current provider context./sideReview the current provider context.",
      ),
    ).toBe("Review the current provider context.");
    expect(normalizeAceSideChatPromptText("/btw inspect Claude context")).toBe(
      "/btw inspect Claude context",
    );
    expect(normalizeAceSideChatPromptText(".side inspect Codex context")).toBe(
      ".side inspect Codex context",
    );
  });
});
