import { describe, expect, it } from "vitest";

import { buildExpandedImagePreview, resolveExpandedImageItem } from "./ExpandedImagePreview";

describe("expanded image previews", () => {
  it("resolves the selected image from a valid preview", () => {
    const preview = buildExpandedImagePreview(
      [
        { id: "one", name: "one.png", previewUrl: "blob:one" },
        { id: "two", name: "two.png", previewUrl: "blob:two" },
      ],
      "two",
    );

    expect(resolveExpandedImageItem(preview)).toEqual({
      name: "two.png",
      src: "blob:two",
    });
  });

  it("does not resolve malformed previews", () => {
    expect(resolveExpandedImageItem(null)).toBeNull();
    expect(resolveExpandedImageItem({ images: [], index: 0 })).toBeNull();
    expect(
      resolveExpandedImageItem({
        images: [{ name: "one.png", src: "blob:one" }],
        index: 1,
      }),
    ).toBeNull();
  });
});
