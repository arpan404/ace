import { describe, expect, it } from "vitest";

import {
  appendWorkspaceCodeContextToPrompt,
  buildWorkspaceCodeCommentPrompt,
  buildWorkspaceSelectionContext,
  buildWorkspaceSelectionPrompt,
  countOpenWorkspaceCodeComments,
  createWorkspaceCodeComment,
  formatWorkspaceCodeCommentTitle,
  formatWorkspaceRangeLabel,
  updateWorkspaceCodeCommentStatus,
} from "./workspaceDesigner";

describe("workspaceDesigner", () => {
  const range = {
    relativePath: "src/editor.ts",
    startLine: 9,
    startColumn: 2,
    endLine: 12,
    endColumn: 8,
  };

  it("formats file and selected line ranges for code comments", () => {
    expect(formatWorkspaceRangeLabel(range)).toBe("src/editor.ts:10-13");
    expect(formatWorkspaceRangeLabel({ ...range, endLine: range.startLine })).toBe(
      "src/editor.ts:10",
    );
  });

  it("creates code comments anchored to file, range, and code", () => {
    const comment = createWorkspaceCodeComment({
      body: "Review this control flow.",
      code: "if (value) {\n  return value;\n}",
      createdAt: "2026-05-04T12:00:00.000Z",
      cwd: "/repo",
      id: "comment-1",
      range,
    });

    expect(formatWorkspaceCodeCommentTitle(comment)).toBe("src/editor.ts:10-13");
    expect(comment.relativePath).toBe("src/editor.ts");
    expect(comment.code).toContain("return value");
    expect(comment.status).toBe("open");
  });

  it("builds a sendable prompt from a code comment", () => {
    const comment = createWorkspaceCodeComment({
      body: "Explain whether this null-check should be inverted.",
      code: "if (node === null) return;",
      createdAt: "2026-05-04T12:00:00.000Z",
      cwd: "/repo",
      id: "comment-2",
      range,
    });

    const prompt = buildWorkspaceCodeCommentPrompt(comment);
    expect(prompt).toContain("Explain whether this null-check should be inverted.");
    expect(prompt).toContain("<workspace_code_context>");
    expect(prompt).toContain('"relativePath": "src/editor.ts"');
    expect(prompt).toContain('"code": "if (node === null) return;"');
  });

  it("appends hidden workspace code context to plain prompts", () => {
    const prompt = appendWorkspaceCodeContextToPrompt("Refactor this branch logic.", {
      code: "if (flag) { return; }",
      cwd: "/repo",
      range,
    });

    expect(prompt).toContain("Refactor this branch logic.\n\n<workspace_code_context>");
    expect(prompt).toContain('"cwd": "/repo"');
    expect(prompt).toContain('"startLine": 9');
  });

  it("filters diagnostics into structured selection context", () => {
    const context = buildWorkspaceSelectionContext({
      cwd: "/repo",
      diagnostics: [
        {
          endColumn: 6,
          endLine: 10,
          message: "Unexpected any.",
          severity: "warning",
          source: "eslint",
          startColumn: 4,
          startLine: 10,
        },
        {
          endColumn: 1,
          endLine: 40,
          message: "Far away.",
          severity: "info",
          startColumn: 0,
          startLine: 40,
        },
      ],
      languageId: "typescript",
      range,
      text: "const value: any = input;",
    });

    expect(context.relativePath).toBe("src/editor.ts");
    expect(context.diagnostics).toHaveLength(1);
    expect(buildWorkspaceSelectionPrompt(context, "fix")).toContain("Unexpected any");
  });

  it("updates and counts unresolved comments", () => {
    const comments = [
      createWorkspaceCodeComment({
        body: "First",
        code: "one()",
        createdAt: "2026-05-04T12:00:00.000Z",
        cwd: "/repo",
        id: "comment-1",
        range,
      }),
      createWorkspaceCodeComment({
        body: "Second",
        code: "two()",
        createdAt: "2026-05-04T12:01:00.000Z",
        cwd: "/repo",
        id: "comment-2",
        range: { ...range, relativePath: "src/other.ts" },
      }),
    ];

    const resolved = updateWorkspaceCodeCommentStatus(comments, "comment-1", "resolved");
    expect(countOpenWorkspaceCodeComments(resolved)).toBe(1);
    expect(countOpenWorkspaceCodeComments(resolved, "src/editor.ts")).toBe(0);
  });
});
