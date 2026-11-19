import { expect, test } from "vitest";
import { allocateRoom, type RoomInput } from "./shell-room.ts";

const sidebar = { open: true, inline: true, width: 340 };
const panel = { open: true, dock: "side", expanded: false, size: 480 } as const;
const room = (window: number, change: Partial<RoomInput> = {}) =>
  allocateRoom({ window, sidebar, panel, ...change });

test("on a big window the panel docks beside the column at its dragged width, the sidebar staying", () => {
  expect(room(1440)).toEqual({
    mode: "beside",
    sidebar: "shown",
    panel: 480,
    bounds: { min: 320, max: 740 },
    main: 620,
  });
});

test("at 1024px the sidebar steps aside for the panel, which keeps its width beside the column", () => {
  const at = room(1024);
  expect(at).toMatchObject({ mode: "beside", sidebar: "yielded", panel: 480, main: 544 });
});

test("at 800px the sidebar yields first, then the panel narrows to its minimum while the column keeps 360px", () => {
  // A sidebar meant to be beside the content still yields at 800px.
  expect(room(800)).toMatchObject({ mode: "beside", sidebar: "yielded", panel: 440, main: 360 });
  // Narrower, the panel gives way down to 320px, the column holding its 360px.
  expect(room(680)).toMatchObject({ panel: 320, main: 360 });
  // Narrower still the panel caps itself rather than covering the column.
  expect(room(660)).toMatchObject({ mode: "beside", panel: 300, main: 360 });
  // Where the window is too narrow for the sidebar beside the content at all, it is a sheet.
  expect(room(800, { sidebar: { ...sidebar, inline: false } })).toMatchObject({
    sidebar: "sheet",
    panel: 440,
    main: 360,
  });
});

test("widths follow the window one pixel at a time, with no step while the sidebar stays put", () => {
  let previous = room(1101);
  for (let width = 1102; width <= 1440; width++) {
    const next = room(width);
    expect(next.sidebar).toBe("shown");
    expect(next.panel - previous.panel).toBeGreaterThanOrEqual(0);
    expect(next.panel - previous.panel).toBeLessThanOrEqual(1);
    expect(next.main).toBeGreaterThanOrEqual(360);
    previous = next;
  }
});

test("a dragged width comes back once the window has room for it again", () => {
  const dragged = { ...panel, size: 620 };
  expect(room(820, { panel: dragged }).panel).toBe(460);
  expect(room(1440, { panel: dragged }).panel).toBe(620);
});

test("a wide sidebar yields on a big window when it would leave too little for the column and the panel", () => {
  const wide = { ...sidebar, width: 532 };
  expect(room(1200, { sidebar: wide }).sidebar).toBe("yielded");
  expect(room(1240, { sidebar: wide }).sidebar).toBe("shown");
});

test("the person's own choice to hide the sidebar stands, and yielding only happens while the panel is open", () => {
  expect(room(1024, { sidebar: { ...sidebar, open: false } }).sidebar).toBe("hidden");
  expect(room(1024, { panel: { ...panel, open: false } })).toMatchObject({
    mode: "closed",
    sidebar: "shown",
    main: 684,
  });
});

test("on a phone-sized window the panel takes the canvas in the column's place", () => {
  const phone = room(420, { sidebar: { ...sidebar, inline: false } });
  expect(phone).toMatchObject({ mode: "replace", sidebar: "sheet", panel: 420, main: 0 });
  expect(room(639, { sidebar: { ...sidebar, inline: false } }).mode).toBe("replace");
  expect(room(640, { sidebar: { ...sidebar, inline: false } }).mode).toBe("beside");
});

test("docked at the bottom, the panel stays a split under the column at every width", () => {
  const bottom = { ...panel, dock: "bottom" } as const;
  for (const width of [420, 800, 1024, 1440])
    expect(room(width, { panel: bottom }).mode).toBe("bottom");
  // Under the column it needs none of the sidebar's room.
  expect(room(1024, { panel: bottom })).toMatchObject({ sidebar: "shown", main: 684 });
});

test("full view gives the panel the canvas, still yielding the sidebar on a crowded window", () => {
  expect(room(1024, { panel: { ...panel, expanded: true } })).toMatchObject({
    mode: "full",
    sidebar: "yielded",
    panel: 1024,
    main: 0,
  });
  expect(room(1440, { panel: { ...panel, expanded: true } })).toMatchObject({
    sidebar: "shown",
    panel: 1100,
  });
});
