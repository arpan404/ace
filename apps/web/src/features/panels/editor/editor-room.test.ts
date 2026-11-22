import { expect, test } from "vitest";
import { explorerWidth, roomAsk } from "./editor-room.ts";

/*
 * The explorer docks beside the code whenever it shows, at every panel width: it never lies over
 * the editor. It gives up width first, so the editor keeps its room; it is hidden only by the
 * person (Hide files, ⌘B).
 */

test.each([
  ["a wide panel docks it at its own width", 900, 236, 236],
  ["a 640px panel still has room for it and the code", 640, 236, 236],
  ["a 480px panel narrows it so the code keeps 320px", 480, 236, 160],
  ["a 400px panel keeps it at its least, the code taking the rest", 400, 236, 160],
  ["a wide explorer narrows as the panel does", 700, 360, 360],
  ["the same explorer at 600px gives the code its room", 600, 360, 280],
  ["a panel not measured yet keeps the explorer's own width", 0, 236, 236],
] as const)("%s", (_name, panel, stored, width) => {
  const docked = explorerWidth(panel, stored);
  expect(docked).toBe(width);
  // The code keeps 320px wherever the explorer can narrow to make room for it.
  if (panel > 0) expect(panel - docked).toBeGreaterThanOrEqual(Math.min(320, panel - 160));
});

const side = { dock: "side", expanded: false } as const;
const explorer = { open: true, width: 236 };

test.each([
  [
    "two groups ask for their room and the docked explorer's",
    840,
    { ...side, size: 640 },
    1600,
    explorer,
    1084,
  ],
  [
    "with the explorer hidden only the groups' room",
    840,
    { ...side, size: 640 },
    1600,
    { ...explorer, open: false },
    848,
  ],
  [
    "nothing when the panel can't get that wide",
    840,
    { ...side, size: 640 },
    920,
    explorer,
    undefined,
  ],
  [
    "nothing when the panel is already wide enough",
    840,
    { ...side, size: 1100 },
    1600,
    explorer,
    undefined,
  ],
  ["nothing in full view", 840, { ...side, expanded: true, size: 480 }, 1600, explorer, undefined],
  [
    "nothing for a bottom panel",
    840,
    { dock: "bottom", expanded: false, size: 480 },
    1600,
    explorer,
    undefined,
  ],
] as const)("%s", (_name, needed, panel, max, docked, ask) => {
  expect(roomAsk({ needed, panel: { ...panel, max }, explorer: docked })).toBe(ask);
});
