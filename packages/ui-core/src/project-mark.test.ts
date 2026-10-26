import { describe, expect, test } from "vitest";
import { projectMark } from "./project-mark.ts";

const image = "data:image/png;base64,AAAA";
const favicon = "https://example.invalid/favicon.png";

describe("a project's mark", () => {
  test("the person's own image wins over the badge they chose and the favicon", () => {
    const mark = projectMark({ icon: image, defaultIcon: favicon, badge: { glyph: "rocket" } });
    expect(mark.image).toBe(image);
    // The glyph stays as the fallback when the image can't load.
    expect(mark.glyph).toBe("rocket");
  });

  test("a chosen badge hides the detected favicon", () => {
    expect(projectMark({ defaultIcon: favicon, badge: { color: "blue" } })).toEqual({
      image: undefined,
      glyph: undefined,
      color: "blue",
    });
  });

  test("with nothing chosen the favicon shows, and without one the initials do", () => {
    expect(projectMark({ defaultIcon: favicon }).image).toBe(favicon);
    expect(projectMark({ icon: null, defaultIcon: null })).toEqual({
      image: undefined,
      glyph: undefined,
      color: undefined,
    });
    expect(projectMark(undefined).image).toBeUndefined();
  });
});
