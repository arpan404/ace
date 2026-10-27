import { expect, test } from "vitest";
import { sourceLine } from "./library-model.ts";

test("a source reads as where it came from and when it was updated", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  const line = sourceLine({ source: "vercel-labs/skills", updatedAt: "2026-04-23T09:00:00Z" }, now);
  expect(line).toMatch(/^vercel-labs\/skills · updated .*23/);
  expect(line).not.toMatch(/2026/);
  expect(sourceLine({ source: "x/y", updatedAt: "2025-04-23T09:00:00Z" }, now)).toMatch(/2025/);
  expect(sourceLine({ source: "vercel-labs/skills" }, now)).toBe("vercel-labs/skills");
});
