import { expect, test } from "vitest";
import {
  closesExplorerOnPick,
  explorerPlace,
  roomAsk,
  showsExplorerToggle,
} from "./editor-room.ts";

test.each([
  [
    "a wide panel with the explorer open docks it, with no Show files",
    900,
    true,
    false,
    false,
    "docked",
    false,
  ],
  [
    "a wide panel with the explorer closed steps it aside behind Show files",
    900,
    false,
    false,
    false,
    "aside",
    true,
  ],
  ["a compact panel keeps it aside until Show files", 480, true, false, false, "aside", true],
  ["a compact panel lays it over the code once shown", 480, true, true, false, "overlay", true],
  [
    "a compact panel with nothing open docks it beside the empty state",
    480,
    true,
    true,
    true,
    "docked",
    false,
  ],
  ["a panel not measured yet counts as wide", 0, true, false, false, "docked", false],
] as const)("%s", (_name, width, open, overlay, empty, place, toggle) => {
  const placed = explorerPlace({ width, open, overlay, empty });
  expect(placed).toBe(place);
  expect(showsExplorerToggle(placed)).toBe(toggle);
});

const side = { dock: "side", expanded: false } as const;
const explorer = { open: true, width: 236 };

test.each([
  [
    "two groups in a 640px panel ask for room with the docked explorer",
    840,
    { ...side, size: 640 },
    1600,
    1084,
  ],
  [
    "two groups ask nothing when the panel can't get that wide",
    840,
    { ...side, size: 640 },
    920,
    undefined,
  ],
  ["a panel already wide enough asks nothing", 840, { ...side, size: 1100 }, 1600, undefined],
  ["full view asks nothing", 840, { ...side, expanded: true, size: 480 }, 1600, undefined],
  [
    "a bottom panel asks nothing",
    840,
    { dock: "bottom", expanded: false, size: 480 },
    1600,
    undefined,
  ],
] as const)("%s", (_name, needed, panel, max, ask) => {
  expect(roomAsk({ needed, panel: { ...panel, max }, explorer })).toBe(ask);
});

test.each([
  ["a single click previews and leaves the compact explorer open", "preview", false],
  ["a double-click or Enter keeps the file and closes it", "keep", true],
  ["an open beside closes it", "side", true],
] as const)("%s", (_name, how, closes) => {
  expect(closesExplorerOnPick(how)).toBe(closes);
});
