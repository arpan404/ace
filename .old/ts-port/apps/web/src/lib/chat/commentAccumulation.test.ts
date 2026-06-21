import { describe, expect, it } from "vitest";

import type { QueuedComposerImageAttachment } from "../../types";
import { buildAccumulatedCommentsPrompt, mergePendingCommentImages } from "./commentAccumulation";

const image = (id: string): QueuedComposerImageAttachment => ({
  type: "image",
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 12,
  dataUrl: `data:image/png;base64,${id}`,
  previewUrl: `data:image/png;base64,${id}`,
});

describe("buildAccumulatedCommentsPrompt", () => {
  it("keeps the user prompt visible and appends hidden browser contexts at the end", () => {
    const prompt = buildAccumulatedCommentsPrompt("Fix the settings page", [
      {
        id: "comment-1",
        source: "browser",
        body: "Reduce the spacing around this row.",
        targetLabel: "/settings/browser",
        detailLabel: ".settings-row",
        hiddenContextBlock:
          '<browser_design_context>\n{"requestId":"DR-1"}\n</browser_design_context>',
        image: image("image-1"),
        createdAt: "2026-05-06T12:00:00.000Z",
      },
    ]);

    expect(prompt).toContain("Fix the settings page");
    expect(prompt).toContain("<accumulated_comments>");
    expect(prompt).toContain("Comment: Reduce the spacing around this row.");
    expect(prompt.trim()).toMatch(/<\/browser_design_context>$/);
  });

  it("supports review comments without screenshots", () => {
    const prompt = buildAccumulatedCommentsPrompt("Follow up on review notes", [
      {
        id: "comment-1",
        source: "review",
        body: "Check the reconnect path for duplicate events.",
        targetLabel: "apps/server/src/providerManager.ts",
        detailLabel: "Turn 4 - 12+ 3-",
        hiddenContextBlock: "<diff_review_context>\n{}\n</diff_review_context>",
        createdAt: "2026-05-06T12:00:00.000Z",
      },
    ]);

    expect(prompt).toContain("1. Review comment");
    expect(prompt).toContain("Target: apps/server/src/providerManager.ts");
    expect(prompt).not.toContain("Screenshot:");
    expect(prompt.trim()).toMatch(/<\/diff_review_context>$/);
  });
});

describe("mergePendingCommentImages", () => {
  it("prepends pending comment screenshots and de-duplicates by id", () => {
    const existing = image("image-1");
    const merged = mergePendingCommentImages(
      [existing, image("image-2")],
      [
        {
          id: "comment-1",
          source: "browser",
          body: "Use this screenshot.",
          targetLabel: "/",
          detailLabel: null,
          hiddenContextBlock: "<browser_design_context>\n{}\n</browser_design_context>",
          image: existing,
          createdAt: "2026-05-06T12:00:00.000Z",
        },
      ],
    );

    expect(merged.map((item) => item.id)).toEqual(["image-1", "image-2"]);
  });

  it("ignores review comments without images", () => {
    const merged = mergePendingCommentImages(
      [image("image-1")],
      [
        {
          id: "comment-1",
          source: "review",
          body: "No screenshot here.",
          targetLabel: "src/app.ts",
          detailLabel: null,
          hiddenContextBlock: "<diff_review_context>\n{}\n</diff_review_context>",
          createdAt: "2026-05-06T12:00:00.000Z",
        },
      ],
    );

    expect(merged.map((item) => item.id)).toEqual(["image-1"]);
  });
});
