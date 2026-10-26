import { expect, it } from "vitest";
import { simulatorActionInput, simulatorTarget, simulatorTree } from "./simulator-ax.ts";

const screen = { width: 1206, height: 2622 };
const element = (fields: Record<string, unknown>, children: unknown[] = []) => ({
  AXLabel: null,
  AXValue: null,
  AXUniqueId: null,
  enabled: true,
  role_description: "button",
  type: "Button",
  children,
  ...fields,
});
// The shape serve-sim's /ax returned for Settings, trimmed: frames are iOS points.
const settings = [
  element(
    { type: "Application", AXLabel: "Settings", frame: { x: 0, y: 0, width: 402, height: 874 } },
    [
      element({ AXLabel: "General", frame: { x: 16, y: 300, width: 370, height: 52 } }),
      element({
        type: "Switch",
        AXLabel: "Airplane Mode",
        AXValue: "1",
        AXUniqueId: "airplane",
        frame: { x: 16, y: 200, width: 370, height: 52 },
      }),
      element({
        AXLabel: "Disabled",
        enabled: false,
        frame: { x: 16, y: 400, width: 370, height: 52 },
      }),
      element({ type: "ScrollView", frame: { x: 0, y: 100, width: 402, height: 700 } }),
      { frame: "not a frame", AXLabel: "broken" },
      element({ AXLabel: "Offscreen", frame: { x: 0, y: 2000, width: 100, height: 40 } }),
      element({ AXLabel: "Future", frame: { x: 1, y: 1, width: 2, height: 2 }, newField: [1, 2] }),
    ],
  ),
];

it("maps the accessibility tree to framebuffer pixels with actions, states and refs", () => {
  const tree = simulatorTree(settings, screen, { maxNodes: 64, maxDepth: 4 });
  const [app] = tree.nodes;
  expect(app).toMatchObject({
    role: "Application",
    name: "Settings",
    bounds: { x: 0, y: 0, w: 1206, h: 2622 },
  });
  const byName = Object.fromEntries((app?.children ?? []).map((node) => [node.name, node]));
  expect(byName["General"]).toMatchObject({
    role: "Button",
    bounds: { x: 48, y: 900, w: 1110, h: 156 },
    actions: ["press"],
    states: [],
  });
  expect(byName["Airplane Mode"]).toMatchObject({
    value: "1",
    description: "airplane",
    states: ["checked"],
    actions: ["press", "select"],
  });
  expect(byName["Disabled"]).toMatchObject({ states: ["disabled"], actions: [] });
  expect(byName["Offscreen"]?.states).toEqual(["offscreen"]);
  expect(app?.children.find((node) => node.role === "ScrollView")?.actions).toEqual(["scroll"]);
  // A malformed element is skipped; an unknown field does not drop its element.
  expect(byName["broken"]).toBeUndefined();
  expect(byName["Future"]).toBeDefined();
  expect(tree.truncated).toBe(false);
});

it("refs survive an identical re-read and go stale when the element moves", () => {
  const first = simulatorTree(settings, screen, {});
  const again = simulatorTree(structuredClone(settings), screen, {});
  const general = first.nodes[0]?.children[0];
  if (!general) throw new Error("No General row");
  expect(simulatorTarget(again, general.ref).name).toBe("General");
  const moved = structuredClone(settings);
  moved[0]!.children[0] = element({
    AXLabel: "General",
    frame: { x: 16, y: 360, width: 370, height: 52 },
  });
  expect(() => simulatorTarget(simulatorTree(moved, screen, {}), general.ref)).toThrow("stale");
});

it("node and depth budgets truncate the tree and say so", () => {
  const shallow = simulatorTree(settings, screen, { maxDepth: 0 });
  expect(shallow.nodes[0]?.children).toEqual([]);
  expect(shallow.truncated).toBe(true);
  const few = simulatorTree(settings, screen, { maxNodes: 2 });
  expect(few.nodes[0]?.children.map((node) => node.name)).toEqual(["General"]);
  expect(few.truncated).toBe(true);
});

it("a malformed answer is invalid data", () => {
  expect(() => simulatorTree({ not: "an array" }, screen, {})).toThrow("malformed");
});

it("actions become a tap at the centre, a bounded swipe, or nothing to do", () => {
  const tree = simulatorTree(settings, screen, {});
  const children = tree.nodes[0]?.children ?? [];
  const node = (name: string) => {
    const found = children.find((child) => child.name === name || child.role === name);
    if (!found) throw new Error(name);
    return found;
  };
  expect(simulatorActionInput(node("General"), { ref: "x", action: "press" })).toEqual({
    kind: "tap",
    x: 603,
    y: 978,
  });
  expect(
    simulatorActionInput(node("Airplane Mode"), { ref: "x", action: "select", value: true }),
  ).toEqual({
    kind: "none",
    method: "already_selected",
  });
  expect(() =>
    simulatorActionInput(node("ScrollView"), {
      ref: "x",
      action: "scroll",
      value: { dx: 0, dy: 5000 },
    }),
  ).toThrow();
  expect(
    simulatorActionInput(node("ScrollView"), {
      ref: "x",
      action: "scroll",
      value: { dx: 0, dy: 400 },
    }),
  ).toEqual({
    kind: "swipe",
    x: 603,
    y: 1350,
    toX: 603,
    toY: 950,
    durationMs: 300,
  });
  expect(() => simulatorActionInput(node("Disabled"), { ref: "x", action: "press" })).toThrow(
    "does not support",
  );
});

// An iPhone Duo's inner screen as serve-sim's /ax returned it: the root keeps the window's
// portrait frame while the app is laid out landscape. Its framebuffer stays portrait.
const innerScreen = { width: 2007, height: 2853, orientation: "landscape_left" };
const landscapeSettings = [
  element(
    { type: "Application", AXLabel: "Settings", frame: { x: 0, y: 0, width: 669, height: 951 } },
    [
      element({ type: "Group", frame: { x: 0, y: 0, width: 951, height: 669 } }),
      element({ AXLabel: "About", frame: { x: 340, y: 303.67, width: 527, height: 52 } }),
      element({
        type: "ScrollView",
        AXLabel: "List",
        frame: { x: 340, y: 100, width: 527, height: 500 },
      }),
    ],
  ),
];

it("on a turned screen, elements land where the portrait framebuffer shows them", () => {
  const tree = simulatorTree(landscapeSettings, innerScreen, { maxNodes: 64, maxDepth: 4 });
  const about = tree.nodes[0]?.children.find((node) => node.name === "About");
  // Checked on a live iPhone Duo: a press at this box's centre opens About.
  expect(about).toMatchObject({ bounds: { x: 911, y: 252, w: 156, h: 1581 }, actions: ["press"] });
});

it("a portrait-only app on a turned iPhone keeps its portrait layout", () => {
  const tree = simulatorTree(
    settings,
    { ...screen, orientation: "landscape_left" },
    { maxNodes: 64, maxDepth: 4 },
  );
  const general = tree.nodes[0]?.children.find((node) => node.name === "General");
  expect(general?.bounds).toEqual({ x: 48, y: 900, w: 1110, h: 156 });
});

it("a scroll asked for upright runs across the framebuffer of a turned screen", () => {
  const tree = simulatorTree(landscapeSettings, innerScreen, { maxNodes: 64, maxDepth: 4 });
  const list = tree.nodes[0]?.children.find((node) => node.name === "List");
  if (!list) throw new Error("No list");
  const swipe = simulatorActionInput(
    list,
    { ref: list.ref, action: "scroll", value: { dx: 0, dy: 300 } },
    90,
  );
  // Upright, the finger moves up the screen; on the portrait framebuffer that is leftward.
  expect(swipe).toMatchObject({ kind: "swipe", toY: swipe.kind === "swipe" ? swipe.y : 0 });
  expect(swipe.kind === "swipe" && swipe.x - swipe.toX).toBe(300);
});
