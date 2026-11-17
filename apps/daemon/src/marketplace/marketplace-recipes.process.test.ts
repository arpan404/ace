import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  folder,
  samplePlugin,
  sampleRecipe,
  sampleSkill,
  sampleSuit,
  signedVersion,
} from "@ace/marketplace/testing";
import { fakeMarket, fakeSpade, gitCatalog, marketplaceHarness } from "./test-support.ts";

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

const none = { bots: [], needs: {}, startRoutines: false };
const publish = (input: Parameters<typeof signedVersion>[0]) =>
  market.publish(signedVersion(input), input.files);

async function publishInbox() {
  publish({ type: "spade-skill", name: "triage-mail", files: sampleSkill() });
  publish({ type: "spade-plugin", name: "mail-tools", files: samplePlugin() });
  publish({ type: "spade-bot", name: "inbox", files: sampleRecipe() });
  await harness.ask({ op: "refresh" }, "sources");
}

describe("installing a bot recipe", () => {
  it("installs its skills and plugins, then makes a bot with routines paused and only the grants left on", async () => {
    await publishInbox();
    const { review } = await harness.ask(
      { op: "prepare", source: "market", type: "spade-bot", name: "inbox" },
      "review",
    );
    expect(review.body).toMatchObject({
      type: "spade-bot",
      model: "fast",
      brings: [
        { type: "spade-skill", name: "triage-mail", version: "1.0.0" },
        { type: "spade-plugin", name: "mail-tools", version: "1.0.0" },
      ],
      needs: [
        { key: "connector:gmail", required: true },
        { key: "connector:https://mcp.example.com/mcp", required: false },
        { key: "plugin:mail-tools", required: true },
      ],
    });
    const page = await harness.ask({ op: "readReview", id: review.id, offset: 0 }, "reviewPage");
    expect(page.items).toContainEqual(
      expect.objectContaining({ kind: "execution", section: "spade-plugin/mail-tools" }),
    );
    await harness.ask(
      {
        op: "install",
        id: review.id,
        hash: review.hash,
        choices: { bots: [], needs: { "connector:gmail": false }, startRoutines: false },
      },
      "done",
    );
    expect(spade.made).toEqual([
      expect.objectContaining({
        recipe: expect.objectContaining({ name: "Inbox", model: "fast" }),
        from_recipe: {
          source: "market",
          name: "inbox",
          version: "1.0.0",
          transaction: expect.stringMatching(/^install-/),
        },
        grants: { connectors: [], plugins: ["mail-tools"], skills: ["triage-mail"] },
        start_routines: false,
      }),
    ]);
    const installed = (await harness.ask({ op: "installed" }, "installed")).installed;
    expect(installed.map((item) => [item.type, item.name])).toEqual([
      ["spade-bot", "inbox"],
      ["spade-plugin", "mail-tools"],
      ["spade-skill", "triage-mail"],
    ]);
    const plugins = await harness.plugins.handle({ type: "plugins.list" });
    expect(plugins).toMatchObject({ installs: [expect.objectContaining({ name: "mail-tools" })] });
  });

  it("leaves nothing installed when making the bot fails", async () => {
    await publishInbox();
    spade.setFailCreate(true);
    const { review } = await harness.ask(
      { op: "prepare", source: "market", type: "spade-bot", name: "inbox" },
      "review",
    );
    const result = await harness.service.request({
      op: "install",
      id: review.id,
      hash: review.hash,
      choices: none,
    });
    expect(result).toMatchObject({
      op: "error",
      message: expect.stringContaining("couldn't be made"),
    });
    expect((await harness.ask({ op: "installed" }, "installed")).installed).toEqual([]);
    expect(await harness.plugins.handle({ type: "plugins.list" })).toMatchObject({ installs: [] });
  });

  it("says Spade isn't running and makes nothing while it's away", async () => {
    await publishInbox();
    spade.setRunning(false);
    const { review } = await harness.ask(
      { op: "prepare", source: "market", type: "spade-bot", name: "inbox" },
      "review",
    );
    expect(review.blocked).toMatch(/Spade isn't running/);
    expect(
      await harness.service.request({
        op: "install",
        id: review.id,
        hash: review.hash,
        choices: none,
      }),
    ).toMatchObject({ op: "error" });
    expect(spade.made).toEqual([]);
  });

  it("installs a recipe's own skill folder as a market skill for Spade", async () => {
    publish({
      type: "spade-bot",
      name: "writer",
      files: sampleRecipe(
        { name: "Writer", skills: ["skills/house-style"], plugins: [], needs: { connectors: [] } },
        {
          "skills/house-style/SKILL.md":
            "---\nname: house-style\ndescription: How we write.\n---\nShort sentences.\n",
        },
      ),
    });
    await harness.ask({ op: "refresh" }, "sources");
    const { review } = await harness.ask(
      { op: "prepare", source: "market", type: "spade-bot", name: "writer" },
      "review",
    );
    await harness.ask({ op: "install", id: review.id, hash: review.hash, choices: none }, "done");
    expect(
      (await harness.ask({ op: "spadeSkills" }, "spadeSkills")).skills.map((skill) => skill.name),
    ).toEqual(["house-style"]);
    expect(spade.made[0]).toMatchObject({ grants: { skills: ["house-style"] } });
  });
});

describe("plugins from the market", () => {
  it("are accepted through the plugin manager and allowed for the bots the person picked", async () => {
    publish({ type: "spade-plugin", name: "mail-tools", files: samplePlugin() });
    await harness.ask({ op: "refresh" }, "sources");
    const { review } = await harness.ask(
      { op: "prepare", source: "market", type: "spade-plugin", name: "mail-tools" },
      "review",
    );
    expect(review.body).toMatchObject({ type: "spade-plugin", executions: 2 });
    await harness.ask(
      {
        op: "install",
        id: review.id,
        hash: review.hash,
        choices: { bots: ["bot_9"], needs: {}, startRoutines: false },
      },
      "done",
    );
    expect(spade.allowed.get("bot_9")).toEqual(["mail-tools"]);
    expect(await harness.plugins.handle({ type: "plugins.list" })).toMatchObject({
      installs: [expect.objectContaining({ name: "mail-tools", hash: review.hash })],
    });
  });

  it("run nothing during prepare or install: a planted hook, script and scene record nothing", async () => {
    const marker = join(harness.root, "ran");
    await mkdir(marker);
    const planted = `touch ${join(marker, "x")}`;
    const plugin = folder({
      "ace-plugin.json": JSON.stringify({
        schemaVersion: 1,
        name: "planted",
        version: "1.0.0",
        hooks: [{ event: "SessionStart", command: planted }],
        mcpServers: { s: { type: "stdio", command: "sh", args: ["-c", planted] } },
      }),
    });
    publish({ type: "spade-plugin", name: "planted", files: plugin });
    publish({
      type: "spade-skill",
      name: "triage-mail",
      files: sampleSkill("triage-mail", { "run.sh*": `#!/bin/sh\n${planted}\n` }),
    });
    publish({
      type: "suit",
      name: "harbour-dusk",
      // A draw-only scene that passes ace's scan (one that fetched or recorded would be refused
      // on the device). The hook and script are what would run if install ran anything.
      files: [
        ...sampleSuit(),
        ...folder({
          "scene.js": `export function scene(ctx) { ctx.fillStyle = "#123"; ctx.fillRect(0, 0, 8, 8); }`,
        }),
      ],
    });
    await harness.ask({ op: "refresh" }, "sources");
    for (const [type, name] of [
      ["spade-plugin", "planted"],
      ["spade-skill", "triage-mail"],
      ["suit", "harbour-dusk"],
    ] as const) {
      const { review } = await harness.ask(
        { op: "prepare", source: "market", type, name },
        "review",
      );
      await harness.ask({ op: "install", id: review.id, hash: review.hash, choices: none }, "done");
    }
    expect(await readdir(marker)).toEqual([]);
  });
});

describe("git catalogs", () => {
  it("are a second source: listed as From their address, installed unsigned and unreviewed", async () => {
    const repo = await gitCatalog(
      harness.root,
      {
        name: "team",
        plugins: [],
        entries: [
          { type: "spade-skill", name: "triage-mail", source: "skills/triage", title: "Triage" },
        ],
      },
      { "skills/triage": sampleSkill() },
    );
    const sources = await harness.ask({ op: "addSource", address: repo }, "sources");
    const git = sources.sources.find((source) => source.kind === "git");
    expect(git).toMatchObject({ entries: 1 });
    const found = await harness.ask(
      { op: "search", query: "triage", offset: 0, limit: 50 },
      "search",
    );
    expect(found.entries).toEqual([
      expect.objectContaining({ source: git?.id, from: repo, reviewed: false }),
    ]);
    const { review } = await harness.ask(
      { op: "prepare", source: git!.id, type: "spade-skill", name: "triage-mail" },
      "review",
    );
    expect(review).toMatchObject({ signed: false, reviewed: false, from: repo });
    await harness.ask({ op: "install", id: review.id, hash: review.hash, choices: none }, "done");
    expect((await harness.ask({ op: "spadeSkills" }, "spadeSkills")).skills).toHaveLength(1);
  });

  it("refuse an address that isn't https", async () => {
    expect(
      await harness.service.request({ op: "addSource", address: "http://example.com/catalog.git" }),
    ).toMatchObject({ op: "error", code: "invalid" });
    expect(
      await harness.service.request({
        op: "addSource",
        address: "https://user:pw@example.com/c.git",
      }),
    ).toMatchObject({ op: "error", code: "invalid" });
  });
});
