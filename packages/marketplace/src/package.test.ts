import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkBot } from "./checks/bot.ts";
import { effectKey, grantedEffects, recipeEffects } from "./package.ts";
import { readRecipe } from "./recipe.ts";

const watcher = {
  format: "spade-bot",
  version: 3,
  requires: { runtime: "1", spade: "0.0.25" },
  name: "Flight watcher",
  blurb: "Watches fares.",
  task: "You watch flight fares for the person.",
  model: "fast",
  uses: ["task", "memory", "web", "schedule"],
  triggers: [
    { kind: "message" },
    {
      kind: "schedule",
      name: "Morning check",
      instruction: "Check fares.",
      schedule: "daily at 7:00",
    },
    { kind: "event", name: "After a failure", instruction: "Look.", event: "thread.failed" },
    { kind: "webhook", name: "Fare feed", instruction: "Read the posted fare." },
    { kind: "mention", in: ["threads"] },
  ],
  effects: [
    { effect: "network", hosts: ["api.example-fares.com"], why: "Reads fares." },
    {
      effect: "network",
      grant: { kind: "drive_site", host: "book.example-air.com" },
      why: "Checks a fare page.",
    },
    { effect: "send_as_person", why: "Drafts a mail to your travel agent. You send it." },
  ],
  limits: { spend_alert: { usd_per_day: 0.5 }, workers_at_once: 2 },
  tests: ["tests/watch-a-trip.json"],
  notes: ["The person books."],
  pricing: { kind: "free" },
};

const read = (value: unknown, spade = "0.0.25") =>
  readRecipe(JSON.stringify(value), new Set(), { spade });
const refusals = (value: unknown) => read(value).problems.map((problem) => problem.message);

const file = (path: string, content = "{}", executable = false) => ({
  path,
  content: new TextEncoder().encode(content),
  executable,
});

describe("agent packages", () => {
  it("read a version 3 manifest, its schedule triggers as routines", () => {
    const { recipe, problems } = read(watcher);
    expect(problems).toEqual([]);
    expect(recipe?.version).toBe(3);
    expect(recipe?.routines).toEqual([
      { name: "Morning check", instruction: "Check fares.", schedule: "daily at 7:00" },
    ]);
    expect(recipe?.triggers.map((trigger) => trigger.kind)).toEqual([
      "message",
      "event",
      "webhook",
      "mention",
    ]);
    expect(recipe?.limits).toEqual({ spend_alert: { usd_per_day: 0.5 }, workers_at_once: 2 });
  });

  it("key each declared effect as Spade does, and grant only the switches left on", () => {
    const recipe = read(watcher).recipe!;
    expect(recipeEffects(recipe).map((row) => row.key)).toEqual([
      "network:hosts:api.example-fares.com",
      "network:drive_site:book.example-air.com",
      "send_as_person",
    ]);
    expect(
      grantedEffects(recipe, { "network:hosts:api.example-fares.com": true, publish: true }),
    ).toEqual({
      "network:hosts:api.example-fares.com": true,
      "network:drive_site:book.example-air.com": false,
      send_as_person: false,
    });
    expect(
      effectKey({ effect: "network", hosts: ["b.example.com", "a.example.com"], why: "x" }),
    ).toBe("network:hosts:a.example.com,b.example.com");
  });

  it("read version 2 as version 3 with nothing of version 3's", () => {
    const { recipe } = read({
      format: "spade-bot",
      version: 2,
      name: "Inbox",
      task: "Sort.",
      routines: [{ name: "Morning sort", instruction: "Sort.", schedule: "weekdays at 8:00" }],
      effects: [{ effect: "publish", why: "x" }],
    });
    expect(recipe?.routines).toHaveLength(1);
    expect(recipe?.effects).toEqual([]);
    expect(recipe?.triggers).toEqual([]);
    // Kept as raw data, granting nothing.
    expect(recipe?.extra).toEqual({ effects: [{ effect: "publish", why: "x" }] });
  });

  const effect = (entry: unknown) => ({ ...watcher, effects: [entry] });
  it.each([
    ["an identity field", { ...watcher, publisher: "acme" }, "signed manifest"],
    ["executions", { ...watcher, mcpServers: {} }, "plugin"],
    ["hooks", { ...watcher, hooks: [] }, "plugin"],
    ["a secret", { ...watcher, api_key: "x" }, "secret"],
    ["credential", effect({ effect: "credential", why: "x" }), "credential"],
    [
      "a push grant",
      effect({
        effect: "network",
        grant: { kind: "git_push", repo: "a/b", branch: "x/*" },
        why: "x",
      }),
      "push",
    ],
    [
      "a grant under a send",
      effect({
        effect: "send_as_person",
        grant: { kind: "tool", tool: "send_message" },
        why: "x",
      }),
      "never granted",
    ],
    ["an unknown effect", effect({ effect: "teleport", why: "x" }), "isn't an effect"],
    ["a price", { ...watcher, pricing: { kind: "one_time" } }, "Paid packages aren't offered yet."],
    ["a newer runtime", { ...watcher, requires: { runtime: "2" } }, "Needs a newer Spade"],
    ["a newer Spade", { ...watcher, requires: { spade: "9.0.0" } }, "Needs a newer Spade"],
    ["an unknown module", { ...watcher, uses: ["teleport"] }, "Needs a newer Spade"],
  ])("refuse %s", (_label, value, words) => {
    const result = read(value);
    expect(result.recipe).toBeUndefined();
    expect(refusals(value).some((message) => message.includes(words))).toBe(true);
  });

  it("say once, in Spade's words, that an effect needs its why", () => {
    for (const entry of [{ effect: "network" }, { effect: "publish", why: "  " }])
      expect(refusals(effect(entry))).toEqual([
        "effects[0].why says in a sentence why it needs this",
      ]);
  });

  it("read a missing price as free", () => {
    const { pricing: _pricing, ...free } = watcher;
    expect(read(free).problems).toEqual([]);
  });

  it("keep fields they don't know, listed as not used, granting nothing", () => {
    const { recipe } = read({
      ...watcher,
      effects: [],
      superpowers: { effects: [{ effect: "publish", why: "x" }] },
      surfaces: [{ id: "fare-drop", kind: "card", file: "cards/fare-drop.json" }],
    });
    expect(Object.keys(recipe?.extra ?? {})).toEqual(["superpowers"]);
    expect(recipe?.effects).toEqual([]);
  });

  it("hold a package's folder to bot.json, its README, assets, skills and tests", () => {
    const bot = file("bot.json", JSON.stringify(watcher));
    const ok = checkBot(
      [bot, file("README.md", "# Flight watcher"), file("tests/watch-a-trip.json")],
      {
        spade: "0.0.25",
      },
    );
    expect(ok.problems).toEqual([]);
    const executable = checkBot([
      bot,
      file("tests/watch-a-trip.json"),
      file("run.sh", "echo", true),
    ]);
    expect(executable.problems.map((problem) => problem.message).join(" ")).toContain(
      "executable outside skills/",
    );
    const missing = checkBot([bot]);
    expect(missing.problems.map((problem) => problem.path)).toContain("tests/watch-a-trip.json");
  });
});

/** The accept and refuse rules Spade's reader runs too (`spade_core::package::read`). */
const rules = JSON.parse(
  readFileSync(
    new URL("../../../spade/crates/spade-core/src/package/rules.json", import.meta.url),
    "utf8",
  ),
) as {
  base: Record<string, unknown>;
  cases: { name: string; with: Record<string, unknown>; refused?: string }[];
};

describe("the rules both readers share", () => {
  it.each(rules.cases.map((rule) => [rule.name, rule] as const))("%s", (_name, rule) => {
    const problems = refusals({ ...rules.base, ...rule.with });
    if (rule.refused === undefined) expect(problems).toEqual([]);
    else expect(problems.some((problem) => problem.includes(rule.refused!))).toBe(true);
  });
});
