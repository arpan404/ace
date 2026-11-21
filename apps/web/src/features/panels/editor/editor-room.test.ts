import { expect, test } from "vitest";
import { explorerPlace, roomAsk, showsExplorerToggle } from "./editor-room.ts";

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
  ["two groups in a 480px panel ask for 648px", 640, { ...side, size: 480 }, 648],
  ["three groups ask for room for the docked explorer too", 960, { ...side, size: 600 }, 1204],
  ["a panel already wide enough asks nothing", 640, { ...side, size: 700 }, undefined],
  ["full view asks nothing", 640, { ...side, expanded: true, size: 480 }, undefined],
  ["a bottom panel asks nothing", 640, { dock: "bottom", expanded: false, size: 480 }, undefined],
] as const)("%s", (_name, needed, panel, ask) => {
  expect(roomAsk({ needed, panel, explorer })).toBe(ask);
});
