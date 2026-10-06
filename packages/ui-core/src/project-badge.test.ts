import { expect, test } from "vitest";
import {
  projectBadge,
  projectInitials,
  projectLabel,
  projectTint,
  projectTintCount,
} from "./project-badge.ts";

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

test("a project keeps its tint across renames, and different projects use the whole palette", () => {
  const before = projectBadge({ id: "ws-1", name: "relay" });
  const renamed = projectBadge({ id: "ws-1", name: "relay-server" });
  expect(renamed.tint).toBe(before.tint);
  expect(renamed.initials).toBe("RS");

  const tints = Array.from(
    { length: 120 },
    (_, n) => projectBadge({ id: `ws-${n}`, name: "x" }).tint,
  );
  expect(new Set(tints).size).toBe(projectTintCount);
  for (const tint of tints) {
    expect(tint).toBeGreaterThanOrEqual(1);
    expect(tint).toBeLessThanOrEqual(projectTintCount);
  }
});

test("a project's tint is pinned across releases, so no device or upgrade recolours it", () => {
  // Changing the hash or the palette size would repaint every badge people know by colour.
  expect(
    ["ws-billing-api", "ws-ace", "/Users/me/code/relay", "ws-ace-mobile", "docs"].map(projectTint),
  ).toEqual([9, 10, 2, 11, 7]);
});

test("similar ids usually get different tints", () => {
  const tints = ["ace", "ace-mobile", "ace-web", "ace-docs"].map(projectTint);
  expect(new Set(tints).size).toBeGreaterThanOrEqual(3);
});

test("a project reads by its name, else its folder, else a readable id, and never as a UUID", () => {
  const uuid = "a003e031-2390-44d2-b0a7-4a5fd727d463";
  expect(projectLabel(uuid, { name: "scratch", path: "/tmp/scratch" })).toBe("scratch");
  expect(projectLabel(uuid, { name: " ", path: "/Users/dev/billing-api/" })).toBe("billing-api");
  expect(projectLabel("ace")).toBe("ace");
  expect(projectLabel(uuid)).toBe("Project");
  expect(projectLabel("ws-5c99df537a9a44809f3e1dbf4327d94a")).toBe("Project");
});
