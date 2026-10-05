import { expect, test } from "vitest";
import { projectBadge, projectInitials } from "./project-badge.ts";

test("initials take the first letters of the first two words, or the first two of one word", () => {
  expect(projectInitials("billing-api")).toBe("BA");
  expect(projectInitials("ace_mobile")).toBe("AM");
  expect(projectInitials("aceMobile")).toBe("AM");
  expect(projectInitials("docs site v2")).toBe("DS");
  expect(projectInitials("ace")).toBe("AC");
  expect(projectInitials("r")).toBe("R");
  expect(projectInitials("  --  ")).toBe("?");
});

test("initials keep letters outside ASCII whole", () => {
  expect(projectInitials("über-tool")).toBe("ÜT");
  expect(projectInitials("日本語")).toBe("日本");
});

test("a project keeps its colour across renames, and different projects spread over the hues", () => {
  const before = projectBadge({ id: "ws-1", name: "relay" });
  const renamed = projectBadge({ id: "ws-1", name: "relay-server" });
  expect(renamed.hue).toBe(before.hue);
  expect(renamed.initials).toBe("RS");

  const hues = new Set(
    Array.from({ length: 40 }, (_, n) => projectBadge({ id: `ws-${n}`, name: "x" }).hue),
  );
  expect(hues.size).toBeGreaterThanOrEqual(6);
});
