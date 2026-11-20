import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { checkPackage } from "./bot-kit/check.ts";
import { testPackage } from "./bot-kit/test.ts";

/*
 * The ten templates Spade ships are packages by ace (ADR 0200 §3.8): each passes the market's
 * checks as `ace bot check` runs them, with nothing to warn about, and its own scenarios as
 * `ace bot test` runs them on Spade's program.
 */

const templates = fileURLToPath(new URL("../../../../spade/templates", import.meta.url));
const spade = fileURLToPath(new URL("../../../../spade/target/debug/spade", import.meta.url));
const ids = readdirSync(templates, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

it("ships the ten templates", () => {
  expect(ids).toHaveLength(10);
});

it.each(ids)("%s passes ace bot check with no warnings", async (id) => {
  const checked = await checkPackage(`${templates}/${id}`);
  expect(checked.name).toBe(id);
  expect(checked.warnings).toEqual([]);
});

it.skipIf(!existsSync(spade) && process.env.CI !== "true").each(ids)(
  "%s passes its own ace bot test",
  async (id) => {
    const report = await testPackage(`${templates}/${id}`, spade);
    expect(report.passed).toBe(true);
    expect(report.scenarios.length).toBeGreaterThan(0);
  },
);
