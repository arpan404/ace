import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MarketInstallChoices } from "@ace/protocol/marketplace";
import {
  samplePlugin,
  sampleRecipe,
  sampleSkill,
  signedVersion,
  signedWithdrawn,
} from "@ace/marketplace/testing";
import { fakeMarket, fakeSpade, marketplaceHarness } from "./test-support.ts";

/*
 * What an install may never leave behind (ADR 0168 §6, §8): bytes withdrawn after their review,
 * a plugin accepted or granted by an install that failed, a newer plugin left in place by a
 * recipe that rolled back, and a bot nobody installed.
 */

let market: Awaited<ReturnType<typeof fakeMarket>>;
let spade: Awaited<ReturnType<typeof fakeSpade>>;
let harness: Awaited<ReturnType<typeof marketplaceHarness>>;

beforeEach(async () => {
  market = await fakeMarket();
  spade = await fakeSpade();
  harness = await marketplaceHarness({ origin: market.origin, spade });
});
afterEach(async () => {
  await harness.close();
  await market.close();
  await spade.close();
});

const none: MarketInstallChoices = { bots: [], needs: {}, startRoutines: false };
const publish = (input: Parameters<typeof signedVersion>[0]) => {
  const version = signedVersion(input);
  market.publish(version, input.files);
  return version;
};
const prepare = async (type: string, name: string) =>
  (await harness.ask({ op: "prepare", source: "market", type, name }, "review")).review;
const install = (review: { id: string; hash: string }, choices = none) =>
  harness.service.request({ op: "install", id: review.id, hash: review.hash, choices });
const installed = async () => (await harness.ask({ op: "installed" }, "installed")).installed;

/** A newer plugin that fails ADR 0014's import can't be prepared, so v2 differs in a skill text. */
const pluginV2 = () =>
  samplePlugin().map((file) =>
    file.path === "skills/draft/SKILL.md"
      ? Object.assign(file, {
          content: new TextEncoder().encode(
            "---\nname: draft\ndescription: Drafts a better reply.\n---\nDraft it well.\n",
          ),
        })
      : file,
  );

describe("withdrawals learned after a review", () => {
  it("refuse the install of a version withdrawn since its review, and end that review", async () => {
    const version = publish({ type: "spade-skill", name: "triage-mail", files: sampleSkill() });
    await harness.ask({ op: "refresh" }, "sources");
    const review = await prepare("spade-skill", "triage-mail");
    market.withdraw(signedWithdrawn([{ hash: version.hash, reason: "Leaks mail" }], { issued: 5 }));
    expect(await install(review)).toMatchObject({
      op: "error",
      message: expect.stringContaining("Leaks mail"),
    });
    expect(await installed()).toEqual([]);
    expect(
      await harness.service.request({ op: "readReview", id: review.id, offset: 0 }),
    ).toMatchObject({ code: "expired" });
  });

  it("refuse a recipe whose skill was withdrawn since its review", async () => {
    const skill = publish({ type: "spade-skill", name: "triage-mail", files: sampleSkill() });
    publish({ type: "spade-plugin", name: "mail-tools", files: samplePlugin() });
    publish({ type: "spade-bot", name: "inbox", files: sampleRecipe() });
    await harness.ask({ op: "refresh" }, "sources");
    const review = await prepare("spade-bot", "inbox");
    market.withdraw(signedWithdrawn([{ hash: skill.hash, reason: "Leaks mail" }], { issued: 5 }));
    await harness.ask({ op: "refresh" }, "sources");
    expect(
      await harness.service.request({ op: "readReview", id: review.id, offset: 0 }),
    ).toMatchObject({ code: "expired" });
    expect(await install(review)).toMatchObject({ op: "error" });
    expect(spade.made).toEqual([]);
    expect(await installed()).toEqual([]);
  });
});

describe("a plugin install that fails part way", () => {
  it("leaves the plugin unaccepted and every bot's plugins as they were, and the review can be tried again", async () => {
    publish({ type: "spade-plugin", name: "mail-tools", files: samplePlugin() });
    await harness.ask({ op: "refresh" }, "sources");
    spade.allowed.set("bot_a", ["other"]);
    const review = await prepare("spade-plugin", "mail-tools");
    // bot_a takes the grant, then bot_b's write fails.
    spade.setFailPluginWrites(["bot_b"]);
    const choices = { bots: ["bot_a", "bot_b"], needs: {}, startRoutines: false };
    expect(await install(review, choices)).toMatchObject({ op: "error" });
    expect(await harness.acceptedPlugins()).toEqual({});
    expect(spade.allowed.get("bot_a")).toEqual(["other"]);
    expect(spade.allowed.has("bot_b")).toBe(false);
    expect(await installed()).toEqual([]);
    spade.setFailPluginWrites([]);
    expect(await install(review, choices)).toMatchObject({ op: "done" });
    expect(Object.keys(await harness.acceptedPlugins())).toEqual(["mail-tools"]);
    expect(spade.allowed.get("bot_a")).toEqual(["mail-tools", "other"]);
  });
});

describe("a recipe that rolls back", () => {
  it("puts back the plugin version it replaced, with its availability", async () => {
    const first = publish({ type: "spade-plugin", name: "mail-tools", files: samplePlugin() });
    await harness.ask({ op: "refresh" }, "sources");
    const plugin = await prepare("spade-plugin", "mail-tools");
    expect(await install(plugin)).toMatchObject({ op: "done" });
    await harness.plugins.handle({
      type: "plugins.availability",
      name: "mail-tools",
      enabled: true,
      providers: ["codex"],
    });

    publish({ type: "spade-plugin", name: "mail-tools", version: "1.1.0", files: pluginV2() });
    publish({ type: "spade-skill", name: "triage-mail", files: sampleSkill() });
    publish({ type: "spade-bot", name: "inbox", files: sampleRecipe() });
    await harness.ask({ op: "refresh" }, "sources");
    const recipe = await prepare("spade-bot", "inbox");
    spade.setFailCreate(true);
    expect(await install(recipe)).toMatchObject({ op: "error" });
    expect(await harness.acceptedPlugins()).toEqual({ "mail-tools": first.hash });
    expect(await harness.plugins.handle({ type: "plugins.list" })).toMatchObject({
      availability: [{ name: "mail-tools", enabled: true, providers: ["codex"] }],
    });
    expect((await installed()).map((item) => [item.name, item.version])).toEqual([
      ["mail-tools", "1.0.0"],
    ]);
  });
});

describe("making a recipe's bot", () => {
  it("pins the recipe's bytes before Spade makes the bot", async () => {
    const recipe = publish({
      type: "spade-bot",
      name: "solo",
      files: sampleRecipe({ name: "Solo", skills: [], plugins: [], needs: { connectors: [] } }),
    });
    await harness.ask({ op: "refresh" }, "sources");
    const review = await prepare("spade-bot", "solo");
    let pinned = false;
    spade.onCreate(async () => {
      pinned = await access(
        join(harness.root, "marketplace", "objects", `${recipe.hash}.tar`),
      ).then(
        () => true,
        () => false,
      );
    });
    expect(await install(review)).toMatchObject({ op: "done" });
    expect(pinned).toBe(true);
  });

  it("sends a transaction id, and deletes the bot when its answer is lost", async () => {
    publish({
      type: "spade-bot",
      name: "solo",
      files: sampleRecipe({ name: "Solo", skills: [], plugins: [], needs: { connectors: [] } }),
    });
    await harness.ask({ op: "refresh" }, "sources");
    const review = await prepare("spade-bot", "solo");
    spade.setCreate("drop");
    expect(await install(review)).toMatchObject({ op: "error" });
    expect(spade.made[0]).toMatchObject({
      from_recipe: { transaction: expect.stringMatching(/.+/) },
    });
    expect([...spade.bots.keys()]).toEqual([]);
    expect(await installed()).toEqual([]);
  });

  it("rolls an install interrupted while the bot was being made back on the next start", async () => {
    publish({ type: "spade-skill", name: "triage-mail", files: sampleSkill() });
    publish({ type: "spade-plugin", name: "mail-tools", files: samplePlugin() });
    publish({ type: "spade-bot", name: "inbox", files: sampleRecipe() });
    await harness.ask({ op: "refresh" }, "sources");
    const review = await prepare("spade-bot", "inbox");
    const reached = new Promise<void>((resolve) => spade.onCreate(resolve));
    spade.setCreate("hang");
    void install(review);
    await reached;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await harness.restart();
    expect([...spade.bots.keys()]).toEqual([]);
    expect(await installed()).toEqual([]);
    expect(await harness.acceptedPlugins()).toEqual({});
    expect((await harness.ask({ op: "spadeSkills" }, "spadeSkills")).skills).toEqual([]);
  });
});

describe("a publisher's withdrawal", () => {
  it("withdraws their own version only, not another entry holding the same bytes", async () => {
    const version = publish({ type: "spade-skill", name: "triage-mail", files: sampleSkill() });
    await harness.ask({ op: "refresh" }, "sources");
    expect(await install(await prepare("spade-skill", "triage-mail"))).toMatchObject({
      op: "done",
    });
    market.withdraw(
      signedWithdrawn(
        [
          {
            type: "spade-skill",
            name: "a-copy",
            version: "1.0.0",
            hash: version.hash,
            reason: "Mine, withdrawn",
          },
        ],
        { issued: 5 },
      ),
    );
    await harness.ask({ op: "refresh" }, "sources");
    expect(await installed()).toEqual([
      expect.objectContaining({ name: "triage-mail", state: "on" }),
    ]);

    market.withdraw(
      signedWithdrawn([{ hash: version.hash, reason: "Revoked by ace" }], { issued: 6 }),
    );
    await harness.ask({ op: "refresh" }, "sources");
    expect(await installed()).toEqual([
      expect.objectContaining({
        name: "triage-mail",
        state: "withdrawn",
        reason: "Revoked by ace",
      }),
    ]);
  });
});
