import { describe, expect, it } from "vitest";

import {
  getWorkspaceCommentPlaceholder,
  WORKSPACE_COMMENT_PLACEHOLDERS_BY_CONTEXT,
} from "./workspaceCommentPlaceholders";

describe("workspaceCommentPlaceholders", () => {
  it("keeps every context concise and populated", () => {
    for (const placeholders of Object.values(WORKSPACE_COMMENT_PLACEHOLDERS_BY_CONTEXT)) {
      expect(placeholders.length).toBeGreaterThanOrEqual(10);
      for (const placeholder of placeholders) {
        expect(placeholder.trim()).toBe(placeholder);
        expect(placeholder.split(/\s+/u).length).toBeGreaterThanOrEqual(1);
        expect(placeholder.split(/\s+/u).length).toBeLessThanOrEqual(4);
      }
    }
  });

  it("rotates deterministically by interval", () => {
    expect(getWorkspaceCommentPlaceholder({ intervalMs: 1000, timestampMs: 0 })).toBe(
      WORKSPACE_COMMENT_PLACEHOLDERS_BY_CONTEXT.general[0],
    );
    expect(getWorkspaceCommentPlaceholder({ intervalMs: 1000, timestampMs: 1000 })).toBe(
      WORKSPACE_COMMENT_PLACEHOLDERS_BY_CONTEXT.general[1],
    );
    expect(
      getWorkspaceCommentPlaceholder({
        context: "diff",
        intervalMs: 1000,
        timestampMs: 40_000,
      }),
    ).toBe(WORKSPACE_COMMENT_PLACEHOLDERS_BY_CONTEXT.diff[0]);
  });

  it("uses context-specific wording", () => {
    expect(getWorkspaceCommentPlaceholder({ context: "code", timestampMs: 0 })).toBe(
      "Question this logic",
    );
    expect(getWorkspaceCommentPlaceholder({ context: "diff", timestampMs: 0 })).toBe(
      "Review this hunk",
    );
    expect(getWorkspaceCommentPlaceholder({ context: "design", timestampMs: 0 })).toBe(
      "Tighten this UI",
    );
  });
});
