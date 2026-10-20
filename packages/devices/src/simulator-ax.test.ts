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
