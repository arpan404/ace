import { describe, expect, it } from "vitest";

import {
  extractIssueReferenceNumbers,
  splitPromptIntoComposerSegments,
} from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("splitPromptIntoComposerSegments", () => {
  it("splits mention tokens followed by whitespace into mention segments", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md please")).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "AGENTS.md" },
      { type: "text", text: " please" },
    ]);
  });

  it("does not convert an incomplete trailing mention token", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md")).toEqual([
      { type: "text", text: "Inspect @AGENTS.md" },
    ]);
  });

  it("keeps newlines around mention tokens", () => {
    expect(splitPromptIntoComposerSegments("one\n@src/index.ts \ntwo")).toEqual([
      { type: "text", text: "one\n" },
      { type: "mention", path: "src/index.ts" },
      { type: "text", text: " \ntwo" },
    ]);
  });

  it("keeps inline terminal context placeholders at their prompt positions", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Inspect ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}@AGENTS.md please`,
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      { type: "terminal-context", context: null },
      { type: "mention", path: "AGENTS.md" },
      { type: "text", text: " please" },
    ]);
  });

  it("splits tagged issue references in normal message text", () => {
    expect(splitPromptIntoComposerSegments("Please check #351 and #341.")).toEqual([
      { type: "text", text: "Please check " },
      { type: "issue-reference", issueNumber: 351 },
      { type: "text", text: " and " },
      { type: "issue-reference", issueNumber: 341 },
      { type: "text", text: "." },
    ]);
  });

  it("keeps /issues text while still tokenizing tagged issue references", () => {
    expect(splitPromptIntoComposerSegments("/issues #351 and #341")).toEqual([
      { type: "text", text: "/issues " },
      { type: "issue-reference", issueNumber: 351 },
      { type: "text", text: " and " },
      { type: "issue-reference", issueNumber: 341 },
    ]);
  });

  it("tokenizes mentions and issue references in the same message", () => {
    expect(splitPromptIntoComposerSegments("Inspect @AGENTS.md for #42 please")).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "AGENTS.md" },
      { type: "text", text: " for " },
      { type: "issue-reference", issueNumber: 42 },
      { type: "text", text: " please" },
    ]);
  });
});

describe("extractIssueReferenceNumbers", () => {
  it("extracts unique issue numbers from free-form text", () => {
    expect(extractIssueReferenceNumbers("Fix #351, #341, and #351.")).toEqual([351, 341]);
  });

  it("respects common punctuation boundaries around issue tags", () => {
    expect(extractIssueReferenceNumbers("See (#42), then #108.")).toEqual([42, 108]);
  });

  it("ignores hash-like references embedded in words", () => {
    expect(extractIssueReferenceNumbers("c#351 should not tag, but #352 should")).toEqual([352]);
  });
});
