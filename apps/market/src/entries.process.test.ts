import { afterAll, beforeAll, expect, it } from "vitest";
import { sampleSkill } from "@ace/marketplace/testing";
import { computeEntry, readEntrySnapshot, writeEntry } from "./store/entries.ts";
import { publishSigned, startMarket, type Market, catalogueOf } from "./testing/harness.ts";

/*
 * An entry's row follows its versions (ADR 0168 §3). Computing it reads, then writes; a write
 * made from versions another change has since moved past must be refused, never restore stale
 * state.
 */

let market: Market;
beforeAll(async () => {
  market = await startMarket();
});
afterAll(() => market.close());

it("refuses an entry write computed from versions that changed since they were read", async () => {
  await publishSigned(market, {
    type: "spade-skill",
    name: "raced-skill",
    files: sampleSkill("raced-skill"),
  });
  const before = await readEntrySnapshot(
    catalogueOf(market, "spade-skill"),
    "spade-skill",
    "raced-skill",
  );
  if (!before) throw new Error("no entry");
  const stale = computeEntry("raced-skill", before.versions);
  // Another writer marks the version reviewed, and keeps the entry in step.
  await publishSigned(market, {
    type: "spade-skill",
    name: "raced-skill",
    version: "1.1.0",
    files: sampleSkill("raced-skill", { "more.md": "more" }),
    reviewed: true,
  });
  expect(
    await writeEntry(
      catalogueOf(market, "spade-skill"),
      "spade-skill",
      "raced-skill",
      stale,
      before.generation,
      Date.now(),
    ),
  ).toBe(false);
  const page = (await (await market.fetch("/v1/entries/spade-skill/raced-skill")).json()) as {
    entry: { version: string; reviewed: boolean };
  };
  expect(page.entry).toMatchObject({ version: "1.1.0", reviewed: true });
});
