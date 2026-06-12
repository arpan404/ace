import { describe, expect, it } from "vitest";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildNewThreadRecommendationsPrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  buildWorkspaceSummaryPrompt,
} from "./Prompts.ts";
import {
  normalizeCliError,
  sanitizeNewThreadRecommendations,
  sanitizeThreadTitle,
} from "./Utils.ts";
import { TextGenerationError } from "@ace/contracts";

describe("buildCommitMessagePrompt", () => {
  it("includes staged patch and summary in the prompt", () => {
    const result = buildCommitMessagePrompt({
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md\n+hello",
      includeBranch: false,
    });

    expect(result.prompt).toContain("Staged files:");
    expect(result.prompt).toContain("M README.md");
    expect(result.prompt).toContain("Staged patch:");
    expect(result.prompt).toContain("diff --git a/README.md b/README.md");
    expect(result.prompt).toContain("Branch: main");
    // Should NOT include the branch generation instruction
    expect(result.prompt).not.toContain("branch must be a short semantic git branch fragment");
  });

  it("includes branch generation instruction when includeBranch is true", () => {
    const result = buildCommitMessagePrompt({
      branch: "feature/foo",
      stagedSummary: "M README.md",
      stagedPatch: "diff",
      includeBranch: true,
    });

    expect(result.prompt).toContain("branch must be a short semantic git branch fragment");
    expect(result.prompt).toContain("Return a JSON object with keys: subject, body, branch.");
  });

  it("shows (detached) when branch is null", () => {
    const result = buildCommitMessagePrompt({
      branch: null,
      stagedSummary: "M a.ts",
      stagedPatch: "diff",
      includeBranch: false,
    });

    expect(result.prompt).toContain("Branch: (detached)");
  });
});

describe("buildPrContentPrompt", () => {
  it("includes branch names, commits, and diff in the prompt", () => {
    const result = buildPrContentPrompt({
      baseBranch: "main",
      headBranch: "feature/auth",
      commitSummary: "feat: add login page",
      diffSummary: "3 files changed",
      diffPatch: "diff --git a/auth.ts b/auth.ts\n+export function login()",
    });

    expect(result.prompt).toContain("Base branch: main");
    expect(result.prompt).toContain("Head branch: feature/auth");
    expect(result.prompt).toContain("Commits:");
    expect(result.prompt).toContain("feat: add login page");
    expect(result.prompt).toContain("Diff stat:");
    expect(result.prompt).toContain("3 files changed");
    expect(result.prompt).toContain("Diff patch:");
    expect(result.prompt).toContain("export function login()");
  });
});

describe("buildBranchNamePrompt", () => {
  it("includes the user message in the prompt", () => {
    const result = buildBranchNamePrompt({
      message: "Fix the login timeout bug",
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Fix the login timeout bug");
    expect(result.prompt).not.toContain("Attachment metadata:");
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildBranchNamePrompt({
      message: "Fix the layout from screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-123",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 12345,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("screenshot.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("12345 bytes");
  });
});

describe("buildThreadTitlePrompt", () => {
  it("includes the user message in the prompt", () => {
    const result = buildThreadTitlePrompt({
      message: "Investigate reconnect regressions after session restore",
    });

    expect(result.prompt).toContain("User message:");
    expect(result.prompt).toContain("Investigate reconnect regressions after session restore");
    expect(result.prompt).not.toContain("Attachment metadata:");
  });

  it("includes attachment metadata when attachments are provided", () => {
    const result = buildThreadTitlePrompt({
      message: "Name this thread from the screenshot",
      attachments: [
        {
          type: "image" as const,
          id: "att-456",
          name: "thread.png",
          mimeType: "image/png",
          sizeBytes: 67890,
        },
      ],
    });

    expect(result.prompt).toContain("Attachment metadata:");
    expect(result.prompt).toContain("thread.png");
    expect(result.prompt).toContain("image/png");
    expect(result.prompt).toContain("67890 bytes");
  });
});

describe("buildWorkspaceSummaryPrompt", () => {
  it("includes conversation context and current working tree context", () => {
    const result = buildWorkspaceSummaryPrompt({
      turnState: "completed",
      userRequests: "Make the summary more useful and descriptive.",
      assistantWork: "Updated the summary panel and added new tests.",
      workingTreeSummary: "2 files currently changed, +25 -4",
      workingTreeDiff: "diff --git a/a.ts b/a.ts\n+const summary = true;",
    });

    expect(result.prompt).toContain("Latest turn outcome: completed");
    expect(result.prompt).toContain("Relevant user requests:");
    expect(result.prompt).toContain("Make the summary more useful");
    expect(result.prompt).toContain("Relevant assistant work:");
    expect(result.prompt).toContain("Updated the summary panel");
    expect(result.prompt).toContain("Current working tree summary:");
    expect(result.prompt).toContain("2 files currently changed");
    expect(result.prompt).toContain("Current working tree diff:");
    expect(result.prompt).toContain("const summary = true;");
  });
});

describe("buildNewThreadRecommendationsPrompt", () => {
  it("asks for exactly three recommendations or an empty result", () => {
    const result = buildNewThreadRecommendationsPrompt({
      turns: [
        {
          threadId: "thread-1",
          title: "Fix composer layout",
          latestUserMessage: "Make the composer responsive in split pane mode.",
          latestAssistantMessage: "Updated the composer CSS.",
          updatedAt: "2026-06-12T10:00:00.000Z",
        },
      ],
    });

    expect(result.prompt).toContain("return exactly 3 recommendations");
    expect(result.prompt).toContain("return an empty recommendations array");
    expect(result.prompt).toContain("never use generic wording");
  });
});

describe("sanitizeNewThreadRecommendations", () => {
  it("returns exactly three useful recommendations", () => {
    expect(
      sanitizeNewThreadRecommendations([
        {
          title: "Tighten Composer Layout",
          description: "Refine responsive composer spacing in narrow panes.",
          prompt: "Refine the new-thread composer layout so it stays balanced in narrow panes.",
        },
        {
          title: "Polish GitHub Action",
          description: "Make the issue action feel native to the controls row.",
          prompt: "Polish the GitHub issue action so it fits cleanly with the context controls.",
        },
        {
          title: "Validate Prompt Cache",
          description: "Add checks for cached generated prompt recommendations.",
          prompt:
            "Add validation around cached new-thread recommendations and hide invalid entries.",
        },
      ]),
    ).toHaveLength(3);
  });

  it("hides partial or generic recommendation output", () => {
    expect(
      sanitizeNewThreadRecommendations([
        {
          title: "Start a Task",
          description:
            "The recent turns only contain greetings, so the next useful step is to state the coding task clearly.",
          prompt: "Tell the agent what coding task to work on next.",
        },
        {
          title: "Fix Composer",
          description: "Refine the landing composer placeholder.",
          prompt: "Refine the landing composer placeholder copy and spacing.",
        },
      ]),
    ).toEqual([]);
  });
});

describe("sanitizeThreadTitle", () => {
  it("truncates long titles with the shared sidebar-safe limit", () => {
    expect(
      sanitizeThreadTitle(
        '  "Reconnect failures after restart because the session state does not recover"  ',
      ),
    ).toBe("Reconnect failures after restart because the se...");
  });
});

describe("normalizeCliError", () => {
  it("detects 'Command not found' and includes CLI name in the message", () => {
    const error = normalizeCliError(
      "claude",
      "generateCommitMessage",
      new Error("Command not found: claude"),
      "Something went wrong",
    );

    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Claude CLI");
    expect(error.detail).toContain("not available on PATH");
  });

  it("uses the CLI name from the first argument for codex", () => {
    const error = normalizeCliError(
      "codex",
      "generateBranchName",
      new Error("Command not found: codex"),
      "Something went wrong",
    );

    expect(error).toBeInstanceOf(TextGenerationError);
    expect(error.detail).toContain("Codex CLI");
    expect(error.detail).toContain("not available on PATH");
  });

  it("returns the error as-is if it is already a TextGenerationError", () => {
    const existing = new TextGenerationError({
      operation: "generatePrContent",
      detail: "Already wrapped",
    });

    const result = normalizeCliError("claude", "generatePrContent", existing, "fallback");

    expect(result).toBe(existing);
  });

  it("wraps unknown non-Error values with the fallback message", () => {
    const result = normalizeCliError("codex", "generateCommitMessage", "string error", "fallback");

    expect(result).toBeInstanceOf(TextGenerationError);
    expect(result.detail).toBe("fallback");
  });
});
