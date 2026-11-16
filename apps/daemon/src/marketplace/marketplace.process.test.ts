import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeArchive } from "@ace/marketplace";
import {
  folder,
  sampleSkill,
  sampleSuit,
  signedVersion,
  signedWithdrawn,
  testKey,
} from "@ace/marketplace/testing";
import { fakeMarket, fakeSpade, marketplaceHarness } from "./test-support.ts";

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

const publish = (input: Parameters<typeof signedVersion>[0]) => {
  const version = signedVersion(input);
  market.publish(version, input.files);
  return version;
};
const prepare = (type: string, name: string) =>
  harness.service.request({ op: "prepare", source: "market", type, name });

describe("the daemon's marketplace", () => {
  it("lists what the market offers and searches it on the machine", async () => {
    publish({ type: "spade-skill", name: "triage-mail", files: sampleSkill() });
    publish({ type: "suit", name: "harbour-dusk", files: sampleSuit(), reviewed: true });
    await harness.ask({ op: "refresh" }, "sources");
    const before = market.requests.length;
    const found = await harness.ask(
      { op: "search", query: "harbor", offset: 0, limit: 50 },
      "search",
    );
    expect(found.entries.map((entry) => entry.name)).toEqual(["harbour-dusk"]);
    expect(market.requests.length).toBe(before);
  });

  it("refuses a version whose archive doesn't match its signed manifest, and installs nothing", async () => {
    const version = publish({ type: "spade-skill", name: "triage-mail", files: sampleSkill() });
    market.tamper(
      version.hash,
      writeArchive(sampleSkill("triage-mail", { "extra.sh*": "#!/bin/sh\nrm -rf ~\n" })),
    );
    await harness.ask({ op: "refresh" }, "sources");
    const result = await prepare("spade-skill", "triage-mail");
    expect(result).toMatchObject({ op: "error", code: "refused" });
    expect((await harness.ask({ op: "installed" }, "installed")).installed).toEqual([]);
  });

  it("refuses a version signed by a key this build doesn't ship", async () => {
    publish({
      type: "spade-skill",
      name: "triage-mail",
      files: sampleSkill(),
      key: testKey("test", 99),
    });
    await harness.ask({ op: "refresh" }, "sources");
    expect(await prepare("spade-skill", "triage-mail")).toMatchObject({
      op: "error",
      code: "refused",
    });
  });

  it("installs a Suit that passes into the library without applying it", async () => {
    publish({ type: "suit", name: "harbour-dusk", files: sampleSuit(), reviewed: true });
    await harness.ask({ op: "refresh" }, "sources");
    const { review } = await harness.ask(
      { op: "prepare", source: "market", type: "suit", name: "harbour-dusk" },
      "review",
    );
    expect(review).toMatchObject({
      signed: true,
      reviewed: true,
      body: { type: "suit", passes: true },
    });
    await harness.ask(
      {
        op: "install",
        id: review.id,
        hash: review.hash,
        choices: { bots: [], needs: {}, startRoutines: false },
      },
      "done",
    );
    expect((await harness.suits.list()).map((suit) => suit.id)).toContain("harbour-dusk");
  });

  it("can't install a Suit that fails ace's checks", async () => {
    const files = [...sampleSuit(), ...folder({ "suit.css": ".sidebar { color: red }\n" })];
    publish({ type: "suit", name: "harbour-dusk", files });
    await harness.ask({ op: "refresh" }, "sources");
    const { review } = await harness.ask(
      { op: "prepare", source: "market", type: "suit", name: "harbour-dusk" },
      "review",
    );
    expect(review.blocked).toBeDefined();
    const result = await harness.service.request({
      op: "install",
      id: review.id,
      hash: review.hash,
      choices: { bots: [], needs: {}, startRoutines: false },
    });
    expect(result).toMatchObject({ op: "error", code: "refused" });
    expect((await harness.suits.list()).map((suit) => suit.id)).not.toContain("harbour-dusk");
  });

  it("gives Spade a market skill with its files, replaced on update and gone on remove", async () => {
    publish({
      type: "spade-skill",
      name: "triage-mail",
      files: sampleSkill("triage-mail", { "refs/rules.md": "one" }),
    });
    await harness.ask({ op: "refresh" }, "sources");
    const first = (
      await harness.ask(
        { op: "prepare", source: "market", type: "spade-skill", name: "triage-mail" },
        "review",
      )
    ).review;
    await harness.ask(
      {
        op: "install",
        id: first.id,
        hash: first.hash,
        choices: { bots: [], needs: {}, startRoutines: false },
      },
      "done",
    );
    const skills = await harness.ask({ op: "spadeSkills" }, "spadeSkills");
    expect(skills.skills).toEqual([
      expect.objectContaining({ name: "triage-mail", hash: first.hash }),
    ]);
    const rules = await harness.ask(
      { op: "spadeSkillFiles", name: "triage-mail", path: "refs/rules.md" },
      "spadeSkillFiles",
    );
    expect(Buffer.from(rules.content ?? "", "base64").toString()).toBe("one");

    publish({
      type: "spade-skill",
      name: "triage-mail",
      version: "1.1.0",
      files: sampleSkill("triage-mail", { "refs/rules.md": "two" }),
    });
    await harness.ask({ op: "refresh" }, "sources");
    const listed = await harness.ask({ op: "installed" }, "installed");
    expect(listed.installed[0]).toMatchObject({ version: "1.0.0", update: "1.1.0" });
    // Listed, never applied on its own.
    expect((await harness.ask({ op: "spadeSkills" }, "spadeSkills")).skills[0]?.hash).toBe(
      first.hash,
    );
    const update = (
      await harness.ask({ op: "prepareUpdate", type: "spade-skill", name: "triage-mail" }, "review")
    ).review;
    expect(update.updates).toBe("1.0.0");
    const page = await harness.ask({ op: "readReview", id: update.id, offset: 0 }, "reviewPage");
    expect(page.items).toContainEqual(
      expect.objectContaining({ kind: "change", path: "refs/rules.md", change: "changed" }),
    );
    await harness.ask(
      {
        op: "install",
        id: update.id,
        hash: update.hash,
        choices: { bots: [], needs: {}, startRoutines: false },
      },
      "done",
    );
    const after = await harness.ask(
      { op: "spadeSkillFiles", name: "triage-mail", path: "refs/rules.md" },
      "spadeSkillFiles",
    );
    expect(Buffer.from(after.content ?? "", "base64").toString()).toBe("two");

    await harness.ask({ op: "remove", type: "spade-skill", name: "triage-mail" }, "done");
    expect((await harness.ask({ op: "spadeSkills" }, "spadeSkills")).skills).toEqual([]);
  });

  it("browses from the last listing with the market down, and installed entries keep working", async () => {
    publish({ type: "spade-skill", name: "triage-mail", files: sampleSkill() });
    await harness.ask({ op: "refresh" }, "sources");
    const review = (
      await harness.ask(
        { op: "prepare", source: "market", type: "spade-skill", name: "triage-mail" },
        "review",
      )
    ).review;
    await harness.ask(
      {
        op: "install",
        id: review.id,
        hash: review.hash,
        choices: { bots: [], needs: {}, startRoutines: false },
      },
      "done",
    );
    market.setDown(true);
    harness.advance(2 * 60 * 60_000);
    const sources = await harness.ask({ op: "refresh" }, "sources");
    expect(sources.sources[0]).toMatchObject({
      id: "market",
      problem: expect.stringContaining("503"),
    });
    expect(
      (await harness.ask({ op: "search", query: "triage", offset: 0, limit: 50 }, "search"))
        .entries,
    ).toHaveLength(1);
    const files = await harness.ask(
      { op: "spadeSkillFiles", name: "triage-mail", path: "SKILL.md" },
      "spadeSkillFiles",
    );
    expect(Buffer.from(files.content ?? "", "base64").toString()).toContain("name: triage-mail");
  });

  it("turns a withdrawn Suit off without deleting it, and back on from its pinned bytes", async () => {
    const version = publish({ type: "suit", name: "harbour-dusk", files: sampleSuit() });
    await harness.ask({ op: "refresh" }, "sources");
    const review = (
      await harness.ask(
        { op: "prepare", source: "market", type: "suit", name: "harbour-dusk" },
        "review",
      )
    ).review;
    await harness.ask(
      {
        op: "install",
        id: review.id,
        hash: review.hash,
        choices: { bots: [], needs: {}, startRoutines: false },
      },
      "done",
    );
    market.withdraw(
      signedWithdrawn([{ hash: version.hash, reason: "Hides the Working line" }], { issued: 2 }),
    );
    await harness.ask({ op: "refresh" }, "sources");
    const installed = (await harness.ask({ op: "installed" }, "installed")).installed;
    expect(installed).toEqual([
      expect.objectContaining({
        name: "harbour-dusk",
        state: "withdrawn",
        reason: "Hides the Working line",
      }),
    ]);
    expect((await harness.suits.list()).map((suit) => suit.id)).not.toContain("harbour-dusk");
    await harness.ask({ op: "turnOn", type: "suit", name: "harbour-dusk" }, "done");
    expect((await harness.suits.list()).map((suit) => suit.id)).toContain("harbour-dusk");
  });

  it("refuses pinned bytes changed on disk after they were accepted", async () => {
    const version = publish({ type: "spade-skill", name: "triage-mail", files: sampleSkill() });
    await harness.ask({ op: "refresh" }, "sources");
    const review = (
      await harness.ask(
        { op: "prepare", source: "market", type: "spade-skill", name: "triage-mail" },
        "review",
      )
    ).review;
    await harness.ask(
      {
        op: "install",
        id: review.id,
        hash: review.hash,
        choices: { bots: [], needs: {}, startRoutines: false },
      },
      "done",
    );
    const pinned = join(harness.root, "marketplace", "objects", `${version.hash}.tar`);
    await writeFile(pinned, writeArchive(sampleSkill("triage-mail", { "evil.md": "x" })));
    expect(
      await harness.service.request({
        op: "spadeSkillFiles",
        name: "triage-mail",
        path: "SKILL.md",
      }),
    ).toMatchObject({
      op: "error",
    });
    expect((await readFile(pinned)).byteLength).toBeGreaterThan(0);
  });
});
