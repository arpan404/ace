import { describe, expect, it } from "vitest";

import {
  createMarkedIssueReferenceToken,
  createMarkedProviderCommandToken,
  extractIssueReferenceNumbers,
  splitPromptIntoComposerSegments,
  stripComposerInlineMarkers,
  stripIssueReferenceMarkers,
  stripProviderCommandMarkers,
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

  it("keeps plain # references as text when they were not selected from issue picker", () => {
    expect(splitPromptIntoComposerSegments("Please check #351 and #341.")).toEqual([
      { type: "text", text: "Please check #351 and #341." },
    ]);
  });

  it("splits only marked issue references", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Please check ${createMarkedIssueReferenceToken(351)} and ${createMarkedIssueReferenceToken(341)}.`,
      ),
    ).toEqual([
      { type: "text", text: "Please check " },
      { type: "issue-reference", issueNumber: 351 },
      { type: "text", text: " and " },
      { type: "issue-reference", issueNumber: 341 },
      { type: "text", text: "." },
    ]);
  });

  it("keeps /issues text while still tokenizing marked issue references", () => {
    expect(
      splitPromptIntoComposerSegments(
        `/issues ${createMarkedIssueReferenceToken(351)} and ${createMarkedIssueReferenceToken(341)}`,
      ),
    ).toEqual([
      { type: "text", text: "/issues " },
      { type: "issue-reference", issueNumber: 351 },
      { type: "text", text: " and " },
      { type: "issue-reference", issueNumber: 341 },
    ]);
  });

  it("tokenizes mentions and marked issue references in the same message", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Inspect @AGENTS.md for ${createMarkedIssueReferenceToken(42)} please`,
      ),
    ).toEqual([
      { type: "text", text: "Inspect " },
      { type: "mention", path: "AGENTS.md" },
      { type: "text", text: " for " },
      { type: "issue-reference", issueNumber: 42 },
      { type: "text", text: " please" },
    ]);
  });

  it("splits selected provider command tokens", () => {
    expect(
      splitPromptIntoComposerSegments(
        `${createMarkedProviderCommandToken("frontend-design")} make the UI better`,
      ),
    ).toEqual([
      { type: "provider-command", name: "frontend-design" },
      { type: "text", text: " make the UI better" },
    ]);
  });

  it("splits selected plugin tokens invoked with slash", () => {
    expect(
      splitPromptIntoComposerSegments(
        `Use ${createMarkedProviderCommandToken("browser-use")} for this`,
      ),
    ).toEqual([
      { type: "text", text: "Use " },
      { type: "provider-command", name: "browser-use" },
      { type: "text", text: " for this" },
    ]);
  });
});

describe("extractIssueReferenceNumbers", () => {
  it("extracts unique issue numbers from marked issue tokens", () => {
    expect(
      extractIssueReferenceNumbers(
        `Fix ${createMarkedIssueReferenceToken(351)}, ${createMarkedIssueReferenceToken(341)}, and ${createMarkedIssueReferenceToken(351)}.`,
      ),
    ).toEqual([351, 341]);
  });

  it("returns empty when plain # references are not marked", () => {
    expect(extractIssueReferenceNumbers("See (#42), then #108.")).toEqual([]);
  });

  it("strips issue markers from prompt text", () => {
    expect(
      stripIssueReferenceMarkers(
        `Fix ${createMarkedIssueReferenceToken(351)} and ${createMarkedIssueReferenceToken(42)}`,
      ),
    ).toBe("Fix #351 and #42");
  });

  it("strips provider command markers from prompt text", () => {
    const prompt = `${createMarkedProviderCommandToken("frontend-design")} and ${createMarkedProviderCommandToken("browser-use")}`;
    expect(stripProviderCommandMarkers(prompt)).toBe("/frontend-design and /browser-use");
    expect(stripComposerInlineMarkers(`${prompt} ${createMarkedIssueReferenceToken(351)}`)).toBe(
      "/frontend-design and /browser-use #351",
    );
  });
});
