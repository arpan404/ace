import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folder, samplePackage, signedVersion, signedWithdrawn } from "@ace/marketplace/testing";
import { fakeMarket, fakeSpade, marketplaceHarness } from "./test-support.ts";

/*
 * Agent packages through the daemon's marketplace (ADR 0200 §3.9, §6.1, §8), against a real local
 * market and Spade's link: a version 3 package installs as a linked bot with only the effect
 * switches the person left on; an update and a rollback move that same bot, each after its own
 * review; the rollback reads the bytes pinned here with the market gone; a withdrawn version
 * pauses the bot and deletes nothing. One package can make several bots, each its own install; a
 * bot that moves away leaves this Marketplace; an update held for a bot's turn shows the version
 * running until Spade runs the new one.
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

const version2 = {
  task: "You watch flight and hotel prices for the person.",
  triggers: [
    { kind: "message" },
    {
      kind: "schedule",
      name: "Morning check",
      instruction: "Check every watched trip.",
      schedule: "daily at 7:00",
    },
    { kind: "webhook", name: "Fare feed", instruction: "Read the posted fare." },
  ],
  effects: [
    { effect: "network", hosts: ["api.example-fares.com"], why: "Reads fares." },
    { effect: "send_as_person", why: "Drafts a mail to your travel agent. You send it." },
    { effect: "publish", why: "Posts a weekly fare report." },
  ],
};

function publish(version: string, manifest: Record<string, unknown> = {}) {
  const files = samplePackage(manifest);
  const signed = signedVersion({ type: "spade-bot", name: "flight-watcher", version, files });
  market.publish(signed, files);
  return signed;
}

async function install() {
  const { review } = await harness.ask(
    { op: "prepare", source: "market", type: "spade-bot", name: "flight-watcher" },
    "review",
  );
  await harness.ask(
    {
      op: "install",
      id: review.id,
      hash: review.hash,
      choices: {
        bots: [],
        needs: {},
        startRoutines: false,
        effects: { "network:hosts:api.example-fares.com": true, send_as_person: false },
      },
    },
    "done",
  );
  return review;
}

const none = { bots: [], needs: {}, startRoutines: false };

const installedBots = async () =>
  (await harness.ask({ op: "installed" }, "installed")).installed.filter(
    (item) => item.name === "flight-watcher",
  );
const installedBot = async () => (await installedBots())[0];

describe("agent packages", () => {
  it("install as a linked bot with only the effect switches the person left on", async () => {
    const first = publish("1.0.0");
    await harness.ask({ op: "refresh" }, "sources");
    const review = await install();
    expect(review.body).toMatchObject({
      type: "spade-bot",
      linked: true,
      effects: [
        { key: "network:hosts:api.example-fares.com", why: "Reads fares." },
        { key: "send_as_person", effect: "send_as_person" },
      ],
      limits: { spend_alert: { usd_per_day: 0.5 } },
    });
    expect(spade.made).toEqual([
      expect.objectContaining({
        // Spade reads the published bot.json with its own reader.
        recipe: expect.objectContaining({ version: 3, name: "Flight watcher" }),
        package: { source: "market", name: "flight-watcher", version: "1.0.0", hash: first.hash },
        // What proves that identity to Spade: the market's signature and bot.json's exact text.
        envelope: {
          signed: expect.objectContaining({ body: expect.objectContaining({ hash: first.hash }) }),
          bot_json: expect.stringContaining('"Flight watcher"'),
        },
        switches: { "network:hosts:api.example-fares.com": true, send_as_person: false },
        start_routines: false,
      }),
    ]);
    expect(await installedBot()).toMatchObject({ linked: true, version: "1.0.0" });
  });

  it("send a package's panel pages to Spade beside its manifest", async () => {
    const page =
      '<!doctype html><html><head><title>Trips</title></head><body><script>addEventListener("ace:state", () => {});</script></body></html>';
    const files = [
      ...samplePackage({
        surfaces: [
          { id: "trips", kind: "panel", file: "panels/trips/index.html", title: "Watched trips" },
        ],
      }),
      ...folder({ "panels/trips/index.html": page }),
    ];
    market.publish(
      signedVersion({ type: "spade-bot", name: "flight-watcher", version: "1.0.0", files }),
      files,
    );
    await harness.ask({ op: "refresh" }, "sources");
    await install();
    expect(spade.made).toEqual([
      expect.objectContaining({ pages: { "panels/trips/index.html": page } }),
    ]);
  });

  it("send a contract's schema file beside the signed bot.json, and the manifest with it written in", async () => {
    const schemas = {
      input: {
        type: "object",
        properties: { from: { type: "string", maxLength: 3 } },
        required: ["from"],
      },
      output: { type: "object", properties: { fare: { type: "number" } }, required: ["fare"] },
    };
    const path = "contracts/cheapest-fare.json";
    const text = JSON.stringify(schemas);
    const contract = { name: "cheapest_fare", summary: "The cheapest fare.", effects: [] };
    const files = [
      ...samplePackage({ contracts: [{ ...contract, file: path }] }),
      ...folder({ [path]: text }),
    ];
    market.publish(
      signedVersion({ type: "spade-bot", name: "flight-watcher", version: "1.0.0", files }),
      files,
    );
    await harness.ask({ op: "refresh" }, "sources");
    await install();
    expect(spade.made).toEqual([
      expect.objectContaining({
        // Spade checks the file against the signed manifest and writes it in the same way.
        recipe: expect.objectContaining({ contracts: [{ ...contract, ...schemas }] }),
        envelope: expect.objectContaining({ files: { [path]: text } }),
      }),
    ]);
    const listed = await harness.ask({ op: "spadeBot", name: "flight-watcher" }, "spadeBot");
    expect(listed.contractFiles).toEqual({ [path]: text });
  });

  it("update the same bot after a review that says what stays, and roll back with the market gone", async () => {
    const first = publish("1.0.0");
    await harness.ask({ op: "refresh" }, "sources");
    await install();
    const bot = (await installedBot())?.target;
    const second = publish("2.0.0", version2);
    await harness.ask({ op: "refresh" }, "sources");
    expect(await installedBot()).toMatchObject({ update: "2.0.0" });

    const { review } = await harness.ask(
      { op: "prepareUpdate", type: "spade-bot", name: "flight-watcher" },
      "review",
    );
    expect(review.updates).toBe("1.0.0");
    expect(review.body).toMatchObject({
      update: {
        bot,
        rollback: false,
        plan: { task: "kept", asks_more: ["publish"] },
        asksMore: ["It starts when something posts to it on this machine."],
      },
    });
    await harness.ask({ op: "install", id: review.id, hash: review.hash, choices: none }, "done");
    expect(spade.made).toHaveLength(1);
    expect(spade.packageCalls).toEqual([
      expect.objectContaining({
        bot,
        method: "POST",
        body: expect.objectContaining({
          package: expect.objectContaining({ version: "2.0.0", hash: second.hash }),
          recipe: expect.objectContaining({ task: version2.task }),
        }),
      }),
    ]);
    expect(await installedBot()).toMatchObject({
      version: "2.0.0",
      previous: { version: "1.0.0", hash: first.hash },
    });

    // Offline: the earlier version comes from the bytes pinned here.
    await market.close();
    const back = await harness.ask(
      { op: "prepareRollback", type: "spade-bot", name: "flight-watcher" },
      "review",
    );
    expect(back.review).toMatchObject({ version: "1.0.0", updates: "2.0.0" });
    expect(back.review.body).toMatchObject({ update: { bot, rollback: true } });
    await harness.ask(
      { op: "install", id: back.review.id, hash: back.review.hash, choices: none },
      "done",
    );
    // The rollback proves the earlier version with its signed manifest, kept here: no network.
    expect(spade.packageCalls.at(-1)).toMatchObject({
      bot,
      body: {
        package: { version: "1.0.0", hash: first.hash },
        envelope: { signed: { body: { version: "1.0.0", hash: first.hash } } },
      },
    });
    expect(await installedBot()).toMatchObject({
      version: "1.0.0",
      previous: { version: "2.0.0" },
    });
    market = await fakeMarket();
  });

  it("pause a bot whose version was withdrawn, deleting nothing", async () => {
    const first = publish("1.0.0");
    await harness.ask({ op: "refresh" }, "sources");
    await install();
    const bot = (await installedBot())?.target;
    market.withdraw(
      signedWithdrawn([{ hash: first.hash, reason: "It sent too many requests" }], { issued: 2 }),
    );
    await harness.ask({ op: "refresh" }, "sources");
    expect(await installedBot()).toMatchObject({
      state: "withdrawn",
      reason: "It sent too many requests",
    });
    expect(spade.packageCalls).toEqual([
      expect.objectContaining({
        bot,
        method: "POST",
        path: "/withdrawn",
        body: { reason: "It sent too many requests" },
      }),
    ]);
    expect(spade.bots.has(bot ?? "")).toBe(true);
    await harness.ask({ op: "turnOn", type: "spade-bot", name: "flight-watcher" }, "done");
    expect(spade.packageCalls.at(-1)).toMatchObject({ bot, method: "DELETE", path: "/withdrawn" });
  });

  it("refuse a package that needs a newer Spade than the one running, before install", async () => {
    publish("1.0.0", { requires: { runtime: "1", spade: "99.0.0" } });
    await harness.ask({ op: "refresh" }, "sources");
    const refused = await harness.ask(
      { op: "prepare", source: "market", type: "spade-bot", name: "flight-watcher" },
      "error",
    );
    expect(refused.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "Needs a newer Spade: 99.0.0 or later" }),
      ]),
    );
    expect(spade.made).toEqual([]);
    // The same bytes review once this machine's Spade is new enough.
    spade.setVersion("99.0.0");
    const { review } = await harness.ask(
      { op: "prepare", source: "market", type: "spade-bot", name: "flight-watcher" },
      "review",
    );
    expect(review.body).toMatchObject({ type: "spade-bot", linked: true });
  });

  it("know a linked bot a move brought here, by bytes fetched by its hash, so it updates here", async () => {
    const first = publish("1.0.0");
    await harness.ask({ op: "refresh" }, "sources");
    const link = { source: "market", name: "flight-watcher", version: "1.0.0" };
    // Bytes that don't hash to what the bot has are never taken for it.
    spade.arrive("bot_moved", { ...link, hash: "f".repeat(64) });
    await harness.ask({ op: "refresh" }, "sources");
    expect(await installedBot()).toBeUndefined();

    spade.arrive("bot_moved", { ...link, hash: first.hash });
    await harness.ask({ op: "refresh" }, "sources");
    expect(await installedBot()).toMatchObject({
      linked: true,
      target: "bot_moved",
      version: "1.0.0",
      hash: first.hash,
    });
    expect(spade.made).toEqual([]);

    // A newer version reaches the moved bot as it reaches one installed here.
    const second = publish("2.0.0", version2);
    await harness.ask({ op: "refresh" }, "sources");
    expect(await installedBot()).toMatchObject({ update: "2.0.0" });
    const { review } = await harness.ask(
      { op: "prepareUpdate", type: "spade-bot", name: "flight-watcher" },
      "review",
    );
    await harness.ask({ op: "install", id: review.id, hash: review.hash, choices: none }, "done");
    expect(spade.packageCalls).toEqual([
      expect.objectContaining({
        bot: "bot_moved",
        method: "POST",
        body: expect.objectContaining({
          package: expect.objectContaining({ version: "2.0.0", hash: second.hash }),
        }),
      }),
    ]);
  });

  it("make a second linked bot when the same package is installed again, each its own install", async () => {
    publish("1.0.0");
    await harness.ask({ op: "refresh" }, "sources");
    await install();
    const second = await install();
    // The second install was a new bot's review, not an update of the first.
    expect(second.updates).toBeUndefined();
    expect(spade.made).toHaveLength(2);
    expect((await installedBots()).map((item) => item.target).toSorted()).toEqual([
      "bot_1",
      "bot_2",
    ]);

    // An update names its bot; without one, which bot is unclear.
    publish("2.0.0", version2);
    await harness.ask({ op: "refresh" }, "sources");
    const unclear = await harness.ask(
      { op: "prepareUpdate", type: "spade-bot", name: "flight-watcher" },
      "error",
    );
    expect(unclear.code).toBe("invalid");
    const { review } = await harness.ask(
      { op: "prepareUpdate", type: "spade-bot", name: "flight-watcher", bot: "bot_2" },
      "review",
    );
    expect(review.body).toMatchObject({ update: { bot: "bot_2" } });
    await harness.ask({ op: "install", id: review.id, hash: review.hash, choices: none }, "done");
    const after = await installedBots();
    expect(after.find((item) => item.target === "bot_1")).toMatchObject({ version: "1.0.0" });
    expect(after.find((item) => item.target === "bot_2")).toMatchObject({ version: "2.0.0" });
  });

  it("adopt a moved bot on a machine that already has its package for another bot", async () => {
    const first = publish("1.0.0");
    await harness.ask({ op: "refresh" }, "sources");
    await install();
    spade.arrive("bot_moved", {
      source: "market",
      name: "flight-watcher",
      version: "1.0.0",
      hash: first.hash,
    });
    // Offline: the bytes the other bot's install pinned are the moved bot's too.
    await market.close();
    await harness.ask({ op: "refresh" }, "sources");
    expect((await installedBots()).map((item) => item.target).toSorted()).toEqual([
      "bot_1",
      "bot_moved",
    ]);
    expect(spade.made).toHaveLength(1);
    market = await fakeMarket();
  });

  it("forget the install of a bot that moved away, and keep the others", async () => {
    publish("1.0.0");
    await harness.ask({ op: "refresh" }, "sources");
    await install();
    await install();
    spade.moveAway("bot_1");
    await harness.ask({ op: "refresh" }, "sources");
    expect((await installedBots()).map((item) => item.target)).toEqual(["bot_2"]);
    // A Spade that can't answer says nothing of which bots are here: nothing is forgotten.
    spade.setRunning(false);
    await harness.ask({ op: "refresh" }, "sources");
    expect((await installedBots()).map((item) => item.target)).toEqual(["bot_2"]);
  });

  it("hand Spade a listed package's signed manifest for a bot's suggestion, installing nothing", async () => {
    const first = publish("1.0.0");
    await harness.ask({ op: "refresh" }, "sources");
    const listed = await harness.ask({ op: "spadeBot", name: "flight-watcher" }, "spadeBot");
    expect(listed.signed).toMatchObject({
      body: { name: "flight-watcher", version: "1.0.0", hash: first.hash },
    });
    expect(JSON.parse(listed.botJson)).toMatchObject({ version: 3, name: "Flight watcher" });
    expect(spade.made).toEqual([]);
    expect(await installedBots()).toEqual([]);
    // A name the market doesn't list, and a version it withdrew, are not handed over.
    const missing = await harness.ask({ op: "spadeBot", name: "fare-sniper" }, "error");
    expect(missing.code).toBe("not_found");
    market.withdraw(
      signedWithdrawn([{ hash: first.hash, reason: "It sent too many requests" }], { issued: 2 }),
    );
    await harness.ask({ op: "refresh" }, "sources");
    const withdrawn = await harness.ask({ op: "spadeBot", name: "flight-watcher" }, "error");
    expect(withdrawn).toMatchObject({ code: "refused" });
    expect(withdrawn.message).toContain("It sent too many requests");
  });

  it("show the version running while an update waits for the bot's turn, then the new one", async () => {
    const first = publish("1.0.0");
    await harness.ask({ op: "refresh" }, "sources");
    await install();
    const bot = (await installedBot())?.target ?? "";
    const second = publish("2.0.0", version2);
    await harness.ask({ op: "refresh" }, "sources");
    spade.startTurn(bot);
    const { review } = await harness.ask(
      { op: "prepareUpdate", type: "spade-bot", name: "flight-watcher" },
      "review",
    );
    await harness.ask({ op: "install", id: review.id, hash: review.hash, choices: none }, "done");
    expect(await installedBot()).toMatchObject({
      version: "1.0.0",
      hash: first.hash,
      held: { version: "2.0.0" },
    });
    // Still held after a refresh: Spade runs 1.0.0 until the turn ends.
    await harness.ask({ op: "refresh" }, "sources");
    expect(await installedBot()).toMatchObject({ version: "1.0.0", held: { version: "2.0.0" } });

    spade.finishTurn(bot);
    const now = await installedBot();
    expect(now).toMatchObject({
      version: "2.0.0",
      hash: second.hash,
      previous: { version: "1.0.0", hash: first.hash },
    });
    expect(now?.held).toBeUndefined();
  });
});
