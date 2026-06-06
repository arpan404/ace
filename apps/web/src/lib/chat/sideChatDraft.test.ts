import { ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  NEW_SIDE_CHAT_DRAFT_RUNTIME_MODE,
  NEW_SIDE_CHAT_THREAD_ID,
  isAceSideConversationSupported,
  isNewSideChatDraftSubagentId,
  newSideChatDraftThreadId,
  newSideChatDraftSubagentId,
  normalizeAceSideChatPromptText,
  parseAceSideChatCommand,
  resolveAceSideConversationMode,
  stripAceSideChatCommand,
} from "./sideChatDraft";

describe("sideChatDraft", () => {
  it("builds the Ace-native new side-chat draft identity", () => {
    expect(
      newSideChatDraftThreadId({
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
      }),
    ).toBe(`subagent:thread-1:${NEW_SIDE_CHAT_THREAD_ID}`);
    expect(
      newSideChatDraftThreadId({
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        draftId: "draft-1",
      }),
    ).toBe("subagent:thread-1:draft-1");
  });

  it("builds unique Ace-native side-chat draft subagent identities", () => {
    const first = newSideChatDraftSubagentId();
    const second = newSideChatDraftSubagentId();

    expect(first).not.toBe(second);
    expect(isNewSideChatDraftSubagentId(first)).toBe(true);
    expect(isNewSideChatDraftSubagentId(second)).toBe(true);
    expect(isNewSideChatDraftSubagentId(NEW_SIDE_CHAT_THREAD_ID)).toBe(true);
    expect(isNewSideChatDraftSubagentId("side:thread-1:sent")).toBe(false);
  });

  it("defaults new Ace side-chat drafts to approval-required mode", () => {
    expect(NEW_SIDE_CHAT_DRAFT_RUNTIME_MODE).toBe("approval-required");
  });

  it("enables Ace /side only for explicit side-chat capability modes", () => {
    expect(isAceSideConversationSupported("native-fork")).toBe(true);
    expect(isAceSideConversationSupported("replay-fork")).toBe(true);
    expect(isAceSideConversationSupported("unsupported")).toBe(false);
    expect(isAceSideConversationSupported(undefined)).toBe(false);
  });

  it("resolves Ace /side support from provider defaults before a session exists", () => {
    expect(resolveAceSideConversationMode({ provider: "codex" })).toBe("native-fork");
    expect(resolveAceSideConversationMode({ provider: "githubCopilot" })).toBe("replay-fork");
    expect(resolveAceSideConversationMode({ provider: null })).toBeUndefined();
  });

  it("prefers live session side-chat capability over provider defaults", () => {
    expect(
      resolveAceSideConversationMode({
        provider: "codex",
        sessionMode: "unsupported",
      }),
    ).toBe("unsupported");
  });

  it("prefers provider status side-chat capability over provider defaults", () => {
    expect(
      resolveAceSideConversationMode({
        provider: "codex",
        providerMode: "replay-fork",
      }),
    ).toBe("replay-fork");
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
