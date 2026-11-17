import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHash, hashFiles, readArchive, typeLimits, writeArchive } from "@ace/marketplace";
import { sampleSkill } from "@ace/marketplace/testing";
import type {
  MarketDraft,
  MarketMe,
  MarketPublishAction,
  MarketScanReport,
} from "@ace/protocol/marketplace";
import { fakeMarket, fakeSpade, marketplaceHarness, type Seen } from "./test-support.ts";

/*
 * Publishing through the daemon (ADR 0173 §2, §6): a market grant per action, sent only as
 * Authorization to the market and never kept; signed out and stale sign-ins in the words the
 * app shows; a folder uploaded as its canonical archive; Discover answered offline.
 */

let market: Awaited<ReturnType<typeof fakeMarket>>;
let spade: Awaited<ReturnType<typeof fakeSpade>>;
let harness: Awaited<ReturnType<typeof marketplaceHarness>>;
let uploads: Seen[];

const grantText = "grant-0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const grant = () => Promise.resolve(grantText);

const me: MarketMe = {
  state: "active",
  newPublisher: true,
  limits: {
    uploadsToday: 0,
    uploadsPerDay: 10,
    storedBytes: 0,
    quotaBytes: 256 * 1024 * 1024,
    drafts: 0,
    draftLimit: 20,
  },
  entries: [],
  drafts: [],
  transfers: [],
};
const draft = (hash: string): MarketDraft => ({
  id: "drf_abcdefgh",
  type: "spade-skill",
  name: "triage-mail",
  version: "1.0.0",
  hash,
  size: 100,
  files: 1,
  created: 1,
  updated: 1,
  changelog: "",
  title: "Triage mail",
  problems: [],
  scan: { state: "scanning", read: 0, files: 1 },
});
const discoverBody = {
  featured: [],
  trending: [
    {
      entry: { type: "spade-skill", name: "triage-mail", title: "Triage mail", line: "Sorts mail" },
      rank: 1,
      movement: { kind: "new" },
      week: 12,
    },
  ],
  fresh: [{ type: "suit", name: "harbour-dusk", title: "Harbour dusk" }],
  collections: [],
  publishers: [],
  rankedAt: 5,
};

/** A listing edit's scan as the Worker reports one it holds. */
const heldScan: MarketScanReport = {
  format: "ace-market-scan",
  runnable: false,
  scanner: 1,
  verdict: "warn",
  checks: [],
  findings: [
    {
      check: "hidden",
      rule: "typosquat",
      level: "warn",
      message: "Its title reads like another entry's.",
    },
  ],
  truncated: false,
  read: { files: 0, textBytes: 0 },
};

beforeEach(async () => {
  market = await fakeMarket();
  spade = await fakeSpade();
  harness = await marketplaceHarness({ origin: market.origin, spade });
  uploads = [];
  market.route((seen, _response, answer) => {
    if (seen.method === "GET" && seen.path === "/v1/me") answer(200, me);
    else if (seen.method === "POST" && seen.path.startsWith("/v1/me/drafts?")) {
      uploads.push(seen);
      const files = readArchive(new Uint8Array(seen.body), typeLimits["spade-skill"]);
      answer(201, draft(contentHash(hashFiles(files))));
    } else if (seen.method === "PUT" && seen.path === "/v1/me/handle")
      answer(401, { error: "reauth", message: "The sign-in is too old." });
    // The Worker's answers for writes it took and holds, and for an offer it made.
    else if (seen.method === "PUT" && seen.path.endsWith("/listing"))
      answer(202, { status: "pending", scan: heldScan });
    else if (seen.method === "POST" && seen.path.endsWith("/withdraw"))
      answer(202, { status: "pending", versions: ["1.0.0"] });
    else if (seen.method === "POST" && seen.path.endsWith("/transfer"))
      answer(201, { id: "trf_abcdefgh12", type: "spade-skill", name: "triage-mail", to: "other" });
    else if (seen.path === "/v1/discover") answer(200, discoverBody);
    else return false;
    return true;
  });
});
afterEach(async () => {
  await harness.close();
  await market.close();
  await spade.close();
});

const publish = (
  request: MarketPublishAction,
  port: (() => Promise<string | undefined>) | undefined,
) => harness.service.request({ op: "publish", request }, { grant: port });

/** Every file under `root`, whatever it is, as bytes. */
async function everyFile(root: string): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) out.push(await readFile(join(entry.parentPath, entry.name)));
  return out;
}

describe("the market grant", () => {
  it("answers signed_out when no ace account is signed in, and asks the market nothing", async () => {
    expect(await publish({ action: "me" }, () => Promise.resolve(undefined))).toEqual({
      op: "error",
      code: "signed_out",
      message: "Sign in to publish.",
    });
    expect(await publish({ action: "me" }, undefined)).toMatchObject({ code: "signed_out" });
    expect(market.seen.filter((seen) => seen.path.startsWith("/v1/me"))).toEqual([]);
  });

  it("goes only as Authorization to the market and is never written under the data folder", async () => {
    expect(await publish({ action: "me" }, grant)).toEqual({
      op: "publish",
      answer: { kind: "me", me },
    });
    await harness.ask({ op: "refresh" }, "sources");
    const asked = market.seen.find((seen) => seen.path === "/v1/me");
    expect(asked?.authorization).toBe(`Bearer ${grantText}`);
    for (const seen of market.seen) {
      expect(seen.path).not.toContain(grantText);
      expect(seen.body.toString("latin1")).not.toContain(grantText);
      // Reads carry no grant.
      if (!seen.path.startsWith("/v1/me")) expect(seen.authorization).toBeUndefined();
    }
    const files = await everyFile(harness.root);
    expect(files.length).toBeGreaterThan(0);
    for (const bytes of files) expect(bytes.includes(grantText)).toBe(false);
  });

  it("maps the market's stale sign-in to reauth", async () => {
    expect(await publish({ action: "changeHandle", handle: "new-name" }, grant)).toEqual({
      op: "error",
      code: "reauth",
      message: "Sign in again to do this.",
    });
  });
});

describe("the market's answers", () => {
  const key = { type: "spade-skill" as const, name: "triage-mail" };
  const listing = {
    title: "Triage mail",
    line: "Sorts mail.",
    description: "",
    categories: [],
    keywords: [],
    links: [],
    previews: [],
  };

  it("says a listing edit held for review is pending, with its scan", async () => {
    expect(await publish({ action: "listing", ...key, listing }, grant)).toEqual({
      op: "publish",
      answer: { kind: "pending", what: "listing", scan: heldScan },
    });
  });

  it("says a withdrawal waits for the signer, and an offer was made", async () => {
    expect(await publish({ action: "withdraw", ...key, reason: "Replaced." }, grant)).toEqual({
      op: "publish",
      answer: { kind: "pending", what: "withdrawal" },
    });
    expect(await publish({ action: "transfer", ...key, to: "other" }, grant)).toEqual({
      op: "publish",
      answer: { kind: "done" },
    });
  });
});

describe("drafts", () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "ace-draft-"));
  });
  afterEach(() => rm(folder, { recursive: true, force: true }));

  it("upload a folder as its canonical archive", async () => {
    const files = sampleSkill("triage-mail", { "scripts/sort.sh": "#!/bin/sh\necho sorted\n" });
    for (const file of files) {
      await mkdir(dirname(join(folder, file.path)), { recursive: true });
      await writeFile(join(folder, file.path), file.content);
    }
    const result = await publish(
      {
        action: "draftCreate",
        type: "spade-skill",
        name: "triage-mail",
        version: "1.0.0",
        source: { kind: "folder", path: folder },
      },
      grant,
    );
    expect(result).toMatchObject({ op: "publish", answer: { kind: "draft" } });
    const [upload] = uploads;
    expect(upload?.path).toContain("type=spade-skill");
    expect(upload?.contentType).toBe("application/x-tar");
    const body = new Uint8Array(upload?.body ?? []);
    const sent = readArchive(body, typeLimits["spade-skill"]);
    expect(contentHash(hashFiles(sent))).toBe(contentHash(hashFiles(files)));
    // Canonical: writing what was sent again gives the same bytes.
    expect(Buffer.from(writeArchive(sent)).equals(Buffer.from(body))).toBe(true);
  });

  it("upload one of the person's Suits from its folder in their library, named by id", async () => {
    const suit = join(harness.root, "suits", "quiet-hours");
    await mkdir(suit, { recursive: true });
    await writeFile(
      join(suit, "suit.json"),
      '{"format":1,"id":"quiet-hours","name":"Quiet hours"}',
    );
    const result = await publish(
      {
        action: "draftCreate",
        type: "suit",
        name: "quiet-hours",
        version: "1.0.0",
        source: { kind: "suit", id: "quiet-hours" },
      },
      grant,
    );
    expect(result).toMatchObject({ op: "publish", answer: { kind: "draft" } });
    const sent = readArchive(new Uint8Array(uploads[0]?.body ?? []), typeLimits.suit);
    expect(sent.map((file) => file.path)).toEqual(["suit.json"]);
  });

  it("refuse a folder holding a link, before any grant is asked for", async () => {
    await writeFile(join(folder, "SKILL.md"), "---\nname: x\ndescription: y\n---\n");
    const { symlink } = await import("node:fs/promises");
    await symlink("/etc/hosts", join(folder, "hosts"));
    let asked = false;
    const result = await publish(
      {
        action: "draftCreate",
        type: "spade-skill",
        name: "triage-mail",
        version: "1.0.0",
        source: { kind: "folder", path: folder },
      },
      () => {
        asked = true;
        return grant();
      },
    );
    expect(result).toMatchObject({ op: "error", code: "refused" });
    expect(asked).toBe(false);
    expect(uploads).toEqual([]);
  });
});

describe("Discover", () => {
  it("answers offline from the last read", async () => {
    const first = await harness.ask({ op: "discover" }, "discover");
    expect(first.discover.trending[0]).toMatchObject({
      rank: 1,
      entry: { name: "triage-mail", byAce: false },
    });
    expect(first.discover.fresh.map((entry) => entry.name)).toEqual(["harbour-dusk"]);
    market.setDown(true);
    harness.advance(60_000);
    const offline = await harness.ask({ op: "discover" }, "discover");
    expect(offline.discover).toEqual(first.discover);
  });

  it("says so when it was never read and the market can't be reached", async () => {
    market.setDown(true);
    expect(await harness.service.request({ op: "discover" })).toMatchObject({
      op: "error",
      code: "unavailable",
    });
  });
});
