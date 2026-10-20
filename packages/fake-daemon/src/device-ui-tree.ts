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
 * 390x844 point display, with platform refs as a real accessibility read has them (agents and
 * the device view number the actionable ones @e1, @e2, ...), so a viewer can draw outlines.
 */
export const fakeDeviceUITree: ScreenUITreeResult = ScreenUITreeResult.parse({
  truncated: false,
  nodes: [
    node(
      "ax-app",
      "Application",
      "Settings",
      { x: 0, y: 0, w: 390, h: 844 },
      [],
      [
        node("ax-nav", "NavigationBar", "Settings", { x: 0, y: 47, w: 390, h: 96 }),
        node("ax-search", "SearchField", "Search", { x: 16, y: 150, w: 358, h: 36 }, [
          "press",
          "focus",
        ]),
        node("ax-sign-in", "Button", "Sign in", { x: 16, y: 206, w: 358, h: 76 }, ["press"]),
        node("ax-wifi", "Button", "Wi‑Fi", { x: 16, y: 310, w: 358, h: 44 }, ["press"]),
        node("ax-bluetooth", "Button", "Bluetooth", { x: 16, y: 354, w: 358, h: 44 }, ["press"]),
        node("ax-cellular", "Button", "Cellular", { x: 16, y: 398, w: 358, h: 44 }, ["press"]),
        node("ax-general", "Button", "General", { x: 16, y: 470, w: 358, h: 44 }, ["press"]),
      ],
    ),
  ],
});
