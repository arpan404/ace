import { expect, test } from "vitest";
import { watchVisibleHeight } from "./visible-height.ts";

/** A visual viewport that the test resizes, as iOS does when the keyboard opens or on zoom. */
function phone(layoutHeight: number) {
  const visual = Object.assign(new EventTarget(), { height: layoutHeight, scale: 1 });
  const win = { innerHeight: layoutHeight, visualViewport: visual as unknown as VisualViewport };
  const resize = (height: number, scale = 1) => {
    visual.height = height;
    visual.scale = scale;
    visual.dispatchEvent(new Event("resize"));
  };
  return { win, resize };
}

test("the app learns the height above the keyboard when it opens and loses it when it closes", () => {
  const root = document.createElement("div");
  const { win, resize } = phone(844);
  const stop = watchVisibleHeight(win, root);
  expect(root.style.getPropertyValue("--visible-height")).toBe("");

  resize(508);
  expect(root.style.getPropertyValue("--visible-height")).toBe("508px");

  resize(844);
  expect(root.style.getPropertyValue("--visible-height")).toBe("");
  stop();
});

test("a pinch zoom is not mistaken for a keyboard", () => {
  const root = document.createElement("div");
  const { win, resize } = phone(844);
  const stop = watchVisibleHeight(win, root);
  resize(422, 2);
  expect(root.style.getPropertyValue("--visible-height")).toBe("");
  stop();
});

test("browsers without a visual viewport are left alone", () => {
  const root = document.createElement("div");
  const stop = watchVisibleHeight({ innerHeight: 800, visualViewport: null }, root);
  expect(root.getAttribute("style")).toBeNull();
  stop();
});
