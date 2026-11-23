import type { PackagePlan } from "@ace/protocol/marketplace";
import { expect, test } from "vitest";
import { updateSentences } from "./package-updates.ts";
import { effectLimits, parseSpadePackage } from "./packages.ts";

/* What a package update says it does to a bot's effects, and how a bot's package line reads. */

const plan: PackagePlan = {
  name: "same",
  task: "same",
  face: "same",
  personality: "same",
  routines: [],
  notes_kept: 0,
  asks_more: [],
  off: [],
};

const deploy = (pattern: string) => ({
  key: "network:tool:deploy",
  effect: "network",
  grant: { kind: "tool" as const, tool: "deploy", arguments: { env: pattern } },
});

test("an update names every effect it turns off, from the version in use or from its key", () => {
  const before = [
    { key: "network:hosts:api.fares.com", effect: "network", hosts: ["api.fares.com"] },
  ];

  const words = updateSentences(
    {
      plan: { ...plan, off: ["network:hosts:api.fares.com", "publish:drive_site:x.com"] },
      asksMore: [],
    },
    [],
    before,
  );

  expect(words.changes).toEqual([
    "No longer asks for this, so it's turned off: Reaches api.fares.com.",
    "No longer asks for this, so it's turned off: Acts in pages on x.com as you.",
  ]);
});

test("a tool grant whose arguments widen under the same key is named as a change, both ways", () => {
  const words = updateSentences({ plan, asksMore: [] }, [deploy("*")], [deploy("staging")]);

  expect(words.changes).toEqual([
    "Changes what it asks for: Uses deploy without asking, env matching *. Before: Uses deploy without asking, env matching staging.",
  ]);
});

test("what it asks for more says the tool's argument limits it would be turned on with", () => {
  const words = updateSentences(
    { plan: { ...plan, asks_more: ["network:tool:deploy"] }, asksMore: [] },
    [deploy("staging")],
  );

  expect(words.more).toEqual([
    "Uses deploy without asking, env matching staging. Off until you turn it on.",
  ]);
  expect(effectLimits(deploy("staging"))).toEqual(["env matching staging"]);
});

test("one effect a client can't read leaves the others, and is counted as dropped", () => {
  const link = parseSpadePackage({
    source: "market",
    name: "flights",
    version: "1.0.0",
    hash: "a".repeat(64),
    effects: [
      { key: "k".repeat(2050), effect: "network", hosts: [], why: "Long key.", on: false },
      { key: "x".repeat(3000), effect: "network", why: "Too long.", on: false },
      { key: "publish", effect: "publish", why: "Posts.", on: true },
    ],
  });

  expect(link?.effects.map((each) => each.why)).toEqual(["Long key.", "Posts."]);
  expect(link?.effectsDropped).toBe(1);
  expect(link?.hash).toBe("a".repeat(64));
});
