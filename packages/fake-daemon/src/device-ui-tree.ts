import { ScreenUITreeResult, type ScreenUINode } from "@ace/protocol";

type Bounds = ScreenUINode["bounds"];

function node(
  ref: string,
  role: string,
  name: string,
  bounds: Bounds,
  actions: ScreenUINode["actions"] = [],
  children: ScreenUINode[] = [],
): ScreenUINode {
  return { ref, role, name, bounds, states: [], actions, children };
}

/**
 * The accessibility tree every simulated device answers `ui.tree` with: a Settings screen on a
 * 390x844 point display, so a viewer can draw element outlines and refs.
 */
export const fakeDeviceUITree: ScreenUITreeResult = ScreenUITreeResult.parse({
  truncated: false,
  nodes: [
    node(
      "e1",
      "Application",
      "Settings",
      { x: 0, y: 0, w: 390, h: 844 },
      [],
      [
        node("e2", "NavigationBar", "Settings", { x: 0, y: 47, w: 390, h: 96 }),
        node("e3", "SearchField", "Search", { x: 16, y: 150, w: 358, h: 36 }, ["press", "focus"]),
        node("e7", "Button", "Sign in", { x: 16, y: 206, w: 358, h: 76 }, ["press"]),
        node("e4", "Button", "Wi‑Fi", { x: 16, y: 310, w: 358, h: 44 }, ["press"]),
        node("e5", "Button", "Bluetooth", { x: 16, y: 354, w: 358, h: 44 }, ["press"]),
        node("e6", "Button", "Cellular", { x: 16, y: 398, w: 358, h: 44 }, ["press"]),
        node("e8", "Button", "General", { x: 16, y: 470, w: 358, h: 44 }, ["press"]),
      ],
    ),
  ],
});
