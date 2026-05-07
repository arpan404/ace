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
});
