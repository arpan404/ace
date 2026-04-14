import { ThreadId } from "@ace/contracts";
import { describe, expect, it } from "vitest";

import {
  appendBrowserDesignContextToPrompt,
  appendTerminalContextsToPrompt,
  buildTerminalContextPreviewTitle,
  buildTerminalContextBlock,
  countInlineTerminalContextPlaceholders,
  deriveDisplayedUserMessageState,
  extractBrowserDesignRequestId,
  extractTrailingBrowserDesignContext,
  ensureInlineTerminalContextPlaceholders,
  extractTrailingGitHubIssueContext,
  extractTrailingTerminalContexts,
  filterTerminalContextsWithText,
  formatInlineTerminalContextLabel,
  formatTerminalContextLabel,
  hasTerminalContextText,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  isTerminalContextExpired,
  materializeInlineTerminalContextPrompt,
  removeInlineTerminalContextPlaceholder,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "./terminalContext";

function makeContext(overrides?: Partial<TerminalContextDraft>): TerminalContextDraft {
  return {
    id: "context-1",
    threadId: ThreadId.makeUnsafe("thread-1"),
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 12,
    lineEnd: 13,
    text: "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("terminalContext", () => {
  it("formats terminal labels with line ranges", () => {
    expect(formatTerminalContextLabel(makeContext())).toBe("Terminal 1 lines 12-13");
    expect(
      formatTerminalContextLabel(
        makeContext({
          lineStart: 9,
          lineEnd: 9,
        }),
      ),
    ).toBe("Terminal 1 line 9");
  });

  it("builds a numbered terminal context block", () => {
    expect(buildTerminalContextBlock([makeContext()])).toBe(
      [
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("appends terminal context blocks after prompt text", () => {
    expect(appendTerminalContextsToPrompt("Investigate this", [makeContext()])).toBe(
      [
        "Investigate this",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("replaces inline placeholders with inline terminal labels before appending context blocks", () => {
    expect(
      appendTerminalContextsToPrompt(
        `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} carefully`,
        [makeContext()],
      ),
    ).toBe(
      [
        "Investigate @terminal-1:12-13 carefully",
        "",
        "<terminal_context>",
        "- Terminal 1 lines 12-13:",
        "  12 | git status",
        "  13 | On branch main",
        "</terminal_context>",
      ].join("\n"),
    );
  });

  it("extracts terminal context blocks from message text", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(extractTrailingTerminalContexts(prompt)).toEqual({
      promptText: "Investigate this",
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
    });
  });

  it("derives displayed user message state from terminal context prompts", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    expect(deriveDisplayedUserMessageState(prompt)).toEqual({
      visibleText: "Investigate this",
      copyText: prompt,
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
    });
  });

  it("preserves prompt text when no trailing terminal context block exists", () => {
    expect(extractTrailingTerminalContexts("No attached context")).toEqual({
      promptText: "No attached context",
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    });
  });

  it("extracts trailing github issue context blocks from message text", () => {
    const prompt = [
      "Solve #42: Keep timeline rows stable",
      "",
      "<github_issue_context>",
      "number: 42",
      "title: Keep timeline rows stable",
      "body:",
      "  Repro steps",
      "</github_issue_context>",
    ].join("\n");
    expect(extractTrailingGitHubIssueContext(prompt)).toEqual({
      promptText: "Solve #42: Keep timeline rows stable",
      context: ["number: 42", "title: Keep timeline rows stable", "body:", "  Repro steps"].join(
        "\n",
      ),
    });
  });

  it("hides trailing github issue blocks while preserving terminal context chips", () => {
    const terminalPrompt = appendTerminalContextsToPrompt("Investigate this", [makeContext()]);
    const prompt = [
      terminalPrompt,
      "",
      "<github_issue_context>",
      "number: 99",
      "title: Hidden details",
      "body:",
      "  this should not appear in the user bubble",
      "</github_issue_context>",
    ].join("\n");
    expect(deriveDisplayedUserMessageState(prompt)).toEqual({
      visibleText: "Investigate this",
      copyText: prompt,
      contextCount: 1,
      previewTitle: "Terminal 1 lines 12-13\n12 | git status\n13 | On branch main",
      contexts: [
        {
          header: "Terminal 1 lines 12-13",
          body: "12 | git status\n13 | On branch main",
        },
      ],
    });
  });

  it("extracts hidden browser design context blocks from message text", () => {
    const prompt = appendBrowserDesignContextToPrompt("Fix spacing in this card", {
      requestId: "DR-3A91F6C2",
      pageUrl: "https://example.com/dashboard?view=card",
      pagePath: "/dashboard?view=card",
      selection: { x: 42, y: 88, width: 320, height: 180 },
      targetElement: {
        tagName: "button",
        id: "save-button",
        className: "btn btn-primary",
        selector: "#save-button",
        textSnippet: "Save changes",
        htmlSnippet: "<button id='save-button'>Save changes</button>",
      },
      mainContainer: {
        tagName: "main",
        id: null,
        className: "layout-main",
        selector: "main.layout-main",
        textSnippet: "Dashboard",
        htmlSnippet: "<main class='layout-main'>...</main>",
      },
    });

    expect(extractTrailingBrowserDesignContext(prompt)).toEqual({
      promptText: "Fix spacing in this card",
      context: { requestId: "DR-3A91F6C2" },
    });
    expect(extractBrowserDesignRequestId(prompt)).toBe("DR-3A91F6C2");
  });

  it("hides trailing browser design blocks from rendered user message text", () => {
    const prompt = appendBrowserDesignContextToPrompt("Tighten the hero spacing", {
      requestId: "DR-1A2B3C4D",
      pageUrl: "https://example.com",
      pagePath: "/",
      selection: { x: 10, y: 16, width: 400, height: 220 },
      targetElement: null,
      mainContainer: null,
    });
    expect(deriveDisplayedUserMessageState(prompt)).toEqual({
      visibleText: "Tighten the hero spacing",
      copyText: prompt,
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    });
  });

  it("returns null preview title when every context is invalid", () => {
    expect(
      buildTerminalContextPreviewTitle([
        makeContext({
          terminalId: "   ",
        }),
        makeContext({
          id: "context-2",
          text: "\n\n",
        }),
      ]),
    ).toBeNull();
  });

  it("tracks inline terminal context placeholders in prompt text", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(countInlineTerminalContextPlaceholders(`a${placeholder}b${placeholder}`)).toBe(2);
    expect(ensureInlineTerminalContextPlaceholders("Investigate this", 2)).toBe(
      `${placeholder}${placeholder}Investigate this`,
    );
    expect(insertInlineTerminalContextPlaceholder("abc", 1)).toEqual({
      prompt: `a ${placeholder} bc`,
      cursor: 4,
      contextIndex: 0,
    });
    expect(removeInlineTerminalContextPlaceholder(`a${placeholder}b${placeholder}c`, 1)).toEqual({
      prompt: `a${placeholder}bc`,
      cursor: 3,
    });
    expect(stripInlineTerminalContextPlaceholders(`a${placeholder}b`)).toBe("ab");
  });

  it("inserts a placeholder after a file mention when given the expanded prompt cursor", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(insertInlineTerminalContextPlaceholder("Inspect @package.json ", 22)).toEqual({
      prompt: `Inspect @package.json ${placeholder} `,
      cursor: 24,
      contextIndex: 0,
    });
  });

  it("adds a trailing space and consumes an existing trailing space at the insertion point", () => {
    const placeholder = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
    expect(insertInlineTerminalContextPlaceholder("yo whats", 3)).toEqual({
      prompt: `yo ${placeholder} whats`,
      cursor: 5,
      contextIndex: 0,
    });
  });

  it("marks contexts without snapshot text as expired and filters them from sendable contexts", () => {
    const liveContext = makeContext();
    const expiredContext = makeContext({
      id: "context-2",
      text: "",
    });

    expect(hasTerminalContextText(liveContext)).toBe(true);
    expect(isTerminalContextExpired(liveContext)).toBe(false);
    expect(hasTerminalContextText(expiredContext)).toBe(false);
    expect(isTerminalContextExpired(expiredContext)).toBe(true);
    expect(filterTerminalContextsWithText([expiredContext, liveContext])).toEqual([liveContext]);
  });

  it("formats and materializes inline terminal labels from placeholder positions", () => {
    expect(formatInlineTerminalContextLabel(makeContext())).toBe("@terminal-1:12-13");
    expect(
      materializeInlineTerminalContextPrompt(
        `Investigate ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} carefully`,
        [makeContext()],
      ),
    ).toBe("Investigate @terminal-1:12-13 carefully");
  });
});
