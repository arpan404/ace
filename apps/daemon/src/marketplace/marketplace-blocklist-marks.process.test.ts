import { rename } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sha256Hex,
  signBlocklist,
  signNotices,
  signOfficialList,
  signVerifiedList,
  type ArchiveFile,
} from "@ace/marketplace";
import {
  samplePlugin,
  sampleRecipe,
  sampleSkill,
  signedVersion,
  testKey,
  type SignedVersion,
} from "@ace/marketplace/testing";
import type { MarketInstallChoices } from "@ace/protocol/marketplace";
import { fakeMarket, fakeSpade, marketplaceHarness } from "./test-support.ts";

/*
 * The signed blocklist holds at install and is enforced again on every refresh and at startup;
 * "By ace" and "Verified" on list rows rest on a signed manifest the device verified, never on the
 * publisher id in the unsigned index or Discover (ADR 0174 §8, §13, §14).
 */

let market: Awaited<ReturnType<typeof fakeMarket>>;
let spade: Awaited<ReturnType<typeof fakeSpade>>;
let harness: Awaited<ReturnType<typeof marketplaceHarness>>;
let lists: Record<string, unknown>;
let discoverBody: unknown;

beforeEach(async () => {
  market = await fakeMarket();
  spade = await fakeSpade();
  harness = await marketplaceHarness({ origin: market.origin, spade });
  lists = {};
  discoverBody = undefined;
  market.route((seen, _response, answer) => {
    if (seen.path === "/v1/discover" && discoverBody) {
      answer(200, discoverBody);
      return true;
    }
    const name = /^\/v1\/(blocklist|verified|official|notices)$/.exec(seen.path)?.[1];
    if (!name) return false;
    if (lists[name]) answer(200, lists[name]);
    else answer(404, { error: "not_found", message: "none" });
    return true;
  });
});
afterEach(async () => {
  await harness.close();
  await market.close();
  await spade.close();
});

const none: MarketInstallChoices = { bots: [], needs: {}, startRoutines: false };
const issued = 1_700_000_100_000;
const publish = (version: SignedVersion, files: ArchiveFile[]) => market.publish(version, files);
const blockFile = (file: ArchiveFile, reason: string) =>
  signBlocklist(
    {
      format: "ace-market-blocklist",
      issued,
      hashes: [],
      files: [{ sha256: sha256Hex(file.content), reason }],
      patterns: [],
      key: harness.key.id,
    },
    harness.key,
  );
const fileOf = (files: ArchiveFile[], path: string) => files.find((file) => file.path === path)!;
const installed = async () => (await harness.ask({ op: "installed" }, "installed")).installed;
const prepare = async (type: string, name: string) =>
  (await harness.ask({ op: "prepare", source: "market", type, name }, "review")).review;

describe("installing against the blocklist", () => {
  it("refuses a skill the blocklist names after its review was prepared", async () => {
    const files = sampleSkill("triage-mail", { "notes.md": "Sort by sender.\n" });
    publish(signedVersion({ type: "spade-skill", name: "triage-mail", files }), files);
    await harness.ask({ op: "refresh" }, "sources");
    const review = await prepare("spade-skill", "triage-mail");
    lists["blocklist"] = blockFile(fileOf(files, "notes.md"), "Steals mail");
    const result = await harness.service.request({
      op: "install",
      id: review.id,
      hash: review.hash,
      choices: none,
    });
    expect(result).toMatchObject({ op: "error", code: "blocked" });
    expect(result.op === "error" && result.message).toContain("Steals mail");
    expect(await installed()).toEqual([]);
    expect((await harness.ask({ op: "spadeSkills" }, "spadeSkills")).skills).toEqual([]);
  });

  it("refuses a recipe whose brought skill the blocklist names, and lands nothing it brings", async () => {
    const skill = sampleSkill();
    publish(signedVersion({ type: "spade-skill", name: "triage-mail", files: skill }), skill);
    const plugin = samplePlugin();
    publish(signedVersion({ type: "spade-plugin", name: "mail-tools", files: plugin }), plugin);
    const recipe = sampleRecipe();
    publish(signedVersion({ type: "spade-bot", name: "inbox", files: recipe }), recipe);
    await harness.ask({ op: "refresh" }, "sources");
    const review = await prepare("spade-bot", "inbox");
    lists["blocklist"] = blockFile(fileOf(skill, "SKILL.md"), "Forwards mail away");
    harness.advance(60_000);
    await harness.ask({ op: "refresh" }, "sources");
    const result = await harness.service.request({
      op: "install",
      id: review.id,
      hash: review.hash,
      choices: { bots: [], needs: { "connector:gmail": false }, startRoutines: false },
    });
    expect(result).toMatchObject({ op: "error", code: "blocked" });
    expect(result.op === "error" && result.message).toContain("spade-skill/triage-mail");
    expect(await installed()).toEqual([]);
    expect(spade.made).toEqual([]);
    expect(await harness.acceptedPlugins()).toEqual({});
  });
});

/** An installed skill whose pinned bytes can't be read while the blocklist first arrives. */
const installedWhileUnreadable = async () => {
  const files = sampleSkill("triage-mail", { "notes.md": "Sort by sender.\n" });
  publish(signedVersion({ type: "spade-skill", name: "triage-mail", files }), files);
  await harness.ask({ op: "refresh" }, "sources");
  const review = await prepare("spade-skill", "triage-mail");
  await harness.ask({ op: "install", id: review.id, hash: review.hash, choices: none }, "done");
  const pinned = join(harness.root, "marketplace", "objects", `${review.hash}.tar`);
  await rename(pinned, `${pinned}.away`);
  lists["blocklist"] = blockFile(fileOf(files, "notes.md"), "Steals mail");
  harness.advance(60_000);
  await harness.ask({ op: "refresh" }, "sources");
  expect((await installed())[0]).toMatchObject({ state: "on" });
  await rename(`${pinned}.away`, pinned);
};

describe("the blocklist over what is installed", () => {
  it("turns a match off on the next refresh, though no newer list arrived", async () => {
    await installedWhileUnreadable();
    await harness.ask({ op: "refresh" }, "sources");
    expect((await installed())[0]).toMatchObject({ name: "triage-mail", state: "blocked" });
    expect((await harness.ask({ op: "spadeSkills" }, "spadeSkills")).skills).toEqual([]);
  });

  it("turns a match off at startup", async () => {
    await installedWhileUnreadable();
    market.setDown(true);
    await harness.restart();
    expect((await installed())[0]).toMatchObject({ name: "triage-mail", state: "blocked" });
  });
});

describe("a blocklist learned while installing", () => {
  it("turns an installed skill it names off at once, before any refresh", async () => {
    const skill = sampleSkill("triage-mail", { "notes.md": "Sort by sender.\n" });
    publish(signedVersion({ type: "spade-skill", name: "triage-mail", files: skill }), skill);
    const other = sampleSkill("sort-news", { "notes.md": "Group by topic.\n" });
    publish(signedVersion({ type: "spade-skill", name: "sort-news", files: other }), other);
    await harness.ask({ op: "refresh" }, "sources");
    const first = await prepare("spade-skill", "triage-mail");
    await harness.ask({ op: "install", id: first.id, hash: first.hash, choices: none }, "done");
    const second = await prepare("spade-skill", "sort-news");
    lists["blocklist"] = blockFile(fileOf(skill, "notes.md"), "Steals mail");
    await harness.ask({ op: "install", id: second.id, hash: second.hash, choices: none }, "done");
    const states = Object.fromEntries((await installed()).map((item) => [item.name, item.state]));
    expect(states).toEqual({ "triage-mail": "blocked", "sort-news": "on" });
    const skills = (await harness.ask({ op: "spadeSkills" }, "spadeSkills")).skills;
    expect(skills.map((item) => item.name)).toEqual(["sort-news"]);
  });
});

const officialList = (id: string) =>
  signOfficialList(
    {
      format: "ace-market-official",
      issued,
      publisher: { id, name: "ace" },
      accounts: ["user_ace"],
      key: harness.key.id,
    },
    harness.key,
  );
const verifiedList = (id: string) =>
  signVerifiedList(
    {
      format: "ace-market-verified",
      issued,
      publishers: [{ id, handle: "ace", proofs: [{ kind: "account" as const }], at: issued }],
      key: harness.key.id,
    },
    harness.key,
  );
/** A skill whose signed manifest names pub_test; the index says `claimed` published it. */
const publishSkill = (claimed: { id: string; name: string }) => {
  const files = sampleSkill();
  publish(signedVersion({ type: "spade-skill", name: "triage-mail", files }), files);
  market.claim("spade-skill", "triage-mail", { publisher: claimed, byAce: true, verified: true });
  discoverBody = {
    featured: [],
    trending: [],
    fresh: [
      {
        type: "spade-skill",
        name: "triage-mail",
        title: "Triage mail",
        line: "Sorts mail",
        version: "1.0.0",
        publisher: claimed,
      },
    ],
    collections: [],
    publishers: [],
    rankedAt: 5,
  };
};
const rows = async () => ({
  search: (await harness.ask({ op: "search", query: "triage", offset: 0, limit: 10 }, "search"))
    .entries[0],
  discover: (await harness.ask({ op: "discover" }, "discover")).discover.fresh[0],
});
const read = async () =>
  (
    await harness.ask(
      { op: "read", source: "market", type: "spade-skill", name: "triage-mail" },
      "read",
    )
  ).entry.summary;

describe("marks on list rows", () => {
  it("never come from an official or verified id the index puts on another publisher's entry", async () => {
    publishSkill({ id: "pub_ace", name: "ace" });
    lists["official"] = officialList("pub_ace");
    lists["verified"] = verifiedList("pub_ace");
    await harness.ask({ op: "refresh" }, "sources");
    expect((await read()).byAce).toBe(false);
    await prepare("spade-skill", "triage-mail");
    const { search, discover } = await rows();
    expect(search).toMatchObject({ name: "triage-mail", byAce: false });
    expect(search?.verified).toBeUndefined();
    expect(discover).toMatchObject({ name: "triage-mail", byAce: false });
    expect(discover?.verified).toBeUndefined();
  });

  it("show only once a manifest the device verified names that publisher", async () => {
    publishSkill({ id: "pub_test", name: "tester" });
    lists["official"] = officialList("pub_test");
    lists["verified"] = verifiedList("pub_test");
    await harness.ask({ op: "refresh" }, "sources");
    const before = await rows();
    expect(before.search).toMatchObject({ byAce: false });
    expect(before.search?.verified).toBeUndefined();
    expect(before.discover).toMatchObject({ byAce: false });
    expect(await read()).toMatchObject({ byAce: true, verified: true });
    const after = await rows();
    expect(after.search).toMatchObject({ byAce: true, verified: true });
    expect(after.discover).toMatchObject({ byAce: true, verified: true });
  });
});

describe("subscriptions' terms notices", () => {
  const noticesBy = (key: typeof harness.key, at: number) =>
    signNotices(
      {
        format: "ace-market-notices",
        issued: at,
        notices: [{ provider: "codex", status: "refused", note: "Not for bots", at }],
        key: key.id,
      },
      key,
    );

  it("hands Spade the signed notices with every refresh, and nothing no trusted key signed", async () => {
    lists["notices"] = noticesBy(testKey("stranger", 9), issued);
    await harness.ask({ op: "refresh" }, "sources");
    expect(spade.notices).toEqual([]);

    const signed = noticesBy(harness.key, issued + 1);
    lists["notices"] = signed;
    await harness.ask({ op: "refresh" }, "sources");
    expect(spade.notices).toEqual([{ signed }]);
    // Spade keeps only a newer list, so the same one goes again on the next pass.
    await harness.ask({ op: "refresh" }, "sources");
    expect(spade.notices).toEqual([{ signed }, { signed }]);
  });
});
