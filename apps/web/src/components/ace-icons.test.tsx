import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Icon } from "./icon.tsx";
import { AgentCursorIcon, BrowserUseIcon, ComputerUseIcon } from "./ace-icons.tsx";

test("the agent cursor is filled with the person's accent and outlined in the colour that reads on it", () => {
  const { container } = render(<AgentCursorIcon aria-hidden size={16} />);
  const pebble = container.querySelector("path");
  expect(pebble?.getAttribute("fill")).toBe("var(--ring)");
  expect(pebble?.getAttribute("stroke")).toBe("var(--ring-foreground)");
  expect(container.querySelector("svg")?.getAttribute("width")).toBe("16");
});

test.each([
  ["browser use", BrowserUseIcon],
  ["computer use", ComputerUseIcon],
] as const)("the %s glyph is outlined at rest and solid when active", (_name, glyph) => {
  const solidPaths = (active: boolean) => {
    const { container, unmount } = render(<Icon icon={glyph} size={14} active={active} />);
    const solid = [...container.querySelectorAll("path")].filter(
      (path) => path.getAttribute("fill") === "currentColor",
    ).length;
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("14");
    unmount();
    return solid;
  };
  expect(solidPaths(false)).toBe(0);
  expect(solidPaths(true)).toBeGreaterThan(0);
});
