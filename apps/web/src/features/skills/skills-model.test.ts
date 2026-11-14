import { expect, test } from "vitest";
import { skillCatalog } from "./skills-model.ts";

const install = (name: string) => ({
  name,
  version: "1.2.0",
  commit: "a".repeat(40),
  hash: "b".repeat(64),
  acceptedAt: 0,
});

test("a component is on only while its plugin is on for at least one provider", () => {
  const catalog = skillCatalog(
    [install("tools")],
    [{ name: "tools", enabled: true, providers: [] }],
    [
      {
        plugin: "tools",
        name: "tdd",
        kind: "skill",
        path: "skills/tdd/SKILL.md",
        description: "Red, green, refactor",
        enabled: true,
        providers: [],
      },
    ],
  );
  expect(catalog.map((skill) => [skill.id, skill.enabled])).toEqual([
    ["tools~skill~tdd", false],
    ["plugin~tools", false],
  ]);
  expect(catalog[1]?.description).toBe("Version 1.2.0 · 1 skill");
});
