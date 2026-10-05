import { expect, test } from "vitest";
import { watchKeyboardInset } from "./keyboard-inset.ts";

/** A visual viewport that the test resizes, as iOS does when the keyboard opens. */
function phone(layoutHeight: number) {
  const visual = Object.assign(new EventTarget(), { height: layoutHeight, offsetTop: 0 });
  const win = { innerHeight: layoutHeight, visualViewport: visual as unknown as VisualViewport };
  const keyboard = (height: number, offsetTop = 0) => {
    visual.height = layoutHeight - height - offsetTop;
    visual.offsetTop = offsetTop;
    visual.dispatchEvent(new Event("resize"));
  };
  return { win, keyboard };
}

test("bottom UI learns the keyboard's height when it opens and loses it when it closes", () => {
  const root = document.createElement("div");
  const { win, keyboard } = phone(844);
  const stop = watchKeyboardInset(win, root);
  expect(root.style.getPropertyValue("--kb-inset")).toBe("");

  keyboard(336);
  expect(root.style.getPropertyValue("--kb-inset")).toBe("336px");
  // The page panned up under the keyboard: the covered part is still the keyboard's.
  keyboard(336, 120);
  expect(root.style.getPropertyValue("--kb-inset")).toBe("336px");

  keyboard(0);
  expect(root.style.getPropertyValue("--kb-inset")).toBe("");
  stop();
});

test("browsers without a visual viewport are left alone", () => {
  const root = document.createElement("div");
  const stop = watchKeyboardInset({ innerHeight: 800, visualViewport: null }, root);
  expect(root.getAttribute("style")).toBeNull();
  stop();
});
