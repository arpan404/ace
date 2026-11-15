import { afterEach, expect, it } from "vitest";
import { contrastProblems } from "./colour-check.ts";
import { colourReader, readColours } from "./collect.ts";
import type { SceneFrame } from "./scene-sample.ts";

afterEach(() => {
  document.body.replaceChildren();
});

/** A scene host as the app draws it: the frame's veil under the content, and one line of text. */
function sceneWithText(veil: { background: string; opacity: string }, text: string) {
  const host = document.createElement("div");
  const cover = document.createElement("div");
  cover.setAttribute("data-suit-veil", "");
  cover.style.background = veil.background;
  cover.style.opacity = veil.opacity;
  const part = document.createElement("div");
  part.setAttribute("data-part", "message-agent");
  part.style.color = text;
  const words = document.createElement("span");
  words.textContent = "The replay cursor resets on every resume.";
  words.getBoundingClientRect = () => DOMRect.fromRect({ x: 10, y: 10, width: 300, height: 20 });
  part.append(words);
  host.append(cover, part);
  document.body.append(host);
  return { host, cover };
}

/** The scene's canvas, sampled as one dark cell under the whole window. */
const darkScene = (host: Element, cover: Element): SceneFrame => ({
  host,
  frame: document.createElement("iframe"),
  veils: [cover],
  grid: {
    columns: 1,
    rows: 1,
    pixels: [24, 18, 30, 255],
    box: { left: 0, top: 0, width: 1000, height: 1000 },
  },
});

it("text over a scene reads at full strength: the veil under it fades only its own colour", () => {
  const { host, cover } = sceneWithText(
    { background: "rgb(17, 15, 22)", opacity: "0.35" },
    "rgb(236, 231, 240)",
  );
  const { samples } = readColours(document, [darkScene(host, cover)], colourReader(document));
  expect(samples.map((sample) => sample.part)).toEqual(["message-agent"]);
  expect(contrastProblems(samples, "dark")).toEqual([]);
});

it("text that really is too faint over a scene is still reported", () => {
  const { host, cover } = sceneWithText(
    { background: "rgb(17, 15, 22)", opacity: "0.35" },
    "rgb(70, 66, 76)",
  );
  const { samples } = readColours(document, [darkScene(host, cover)], colourReader(document));
  expect(contrastProblems(samples, "dark").map((problem) => problem.field)).toEqual([
    "message-agent",
  ]);
});
