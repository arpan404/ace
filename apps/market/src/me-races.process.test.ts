import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skeleton } from "@ace/marketplace/profile";
import { sampleSkill } from "@ace/marketplace/testing";
import { startMarket, type Market } from "./testing/harness.ts";
import {
  asAccount,
  draftAndPublish,
  establishedPublisher,
  jsonOf,
  liveVersion,
  sign,
} from "./testing/publisher-harness.ts";
import {
  applyListing,
  deleteNeverListed,
  setArchived,
  setChangelog,
  setDeprecated,
  setLatestPick,
  setPendingListing,
  setVisibility,
} from "./store/me-entries.ts";
import { addAppeal, offerTransfer } from "./store/me-transfers.ts";
import { changeHandle, setPins } from "./store/profiles.ts";
import { addWithdrawal, storePending } from "./store/publish.ts";

/*
 * Races on a publisher's own routes (ADR 0173 §5): a request checks ownership, then something
 * else lands before its write. Each case calls the store as the request would after its check,
 * with the state another request left, against the market's D1.
 */

let market: Market;
let maker: { id: string; handle: string };
let taker: { id: string; handle: string };

beforeAll(async () => {
  market = await startMarket();
  maker = await establishedPublisher(market, "acct_race_maker", "race-maker");
  taker = await establishedPublisher(market, "acct_race_taker", "race-taker");
}, 60_000);
afterAll(() => market.close());

const skill = (name: string, version = "1.0.0") => ({
  type: "spade-skill" as const,
  name,
  version,
  files: sampleSkill(name, { "v.md": version }),
});

const entryRow = (name: string) =>
  market.db
    .prepare(
      `SELECT publisher, visibility, archived, latest_pick, listing, pending_listing, generation
        FROM entries WHERE type = 'spade-skill' AND name = ?1`,
    )
    .bind(name)
    .first();
const versionRow = (name: string) =>
  market.db
    .prepare("SELECT changelog, deprecated FROM versions WHERE type = 'spade-skill' AND name = ?1")
    .bind(name)
    .first();
const count = async (table: string, name: string) =>
  (
    await market.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE type = 'spade-skill' AND name = ?1`)
      .bind(name)
      .first<{ n: number }>()
  )?.n;

/** A live entry of the maker's that a transfer then moved to the taker. */
async function movedEntry(name: string) {
  await liveVersion(market, "acct_race_maker", maker, skill(name));
  await market.db
    .prepare("UPDATE entries SET publisher = ?1 WHERE type = 'spade-skill' AND name = ?2")
    .bind(taker.id, name)
    .run();
  return { type: "spade-skill", name, publisher: maker.id };
}

const listing = {
  title: "Taken over",
  line: "A line.",
  description: "Words.",
  categories: [],
  keywords: [],
  links: [],
  previews: [],
};
const noBucket = { delete: async () => {} } as unknown as R2Bucket;

describe("a former owner's request that lands after a transfer", () => {
  const writes: [string, (key: Awaited<ReturnType<typeof movedEntry>>) => Promise<unknown>][] = [
    ["visibility", (key) => setVisibility(market.db, key, "unlisted", 1)],
    ["archive", (key) => setArchived(market.db, key, true, 1)],
    ["latest", (key) => setLatestPick(market.db, key, "1.0.0", 1)],
    ["listing", (key) => applyListing(market.db, key, listing, 1)],
    [
      "pending listing",
      (key) =>
        setPendingListing(market.db, key, {
          listing,
          scan: {
            format: "ace-market-scan",
            scanner: 1,
            verdict: "pass",
            checks: [],
            findings: [],
            truncated: false,
            read: { files: 0, textBytes: 0 },
          },
          at: 1,
        }),
    ],
    ["changelog", (key) => setChangelog(market.db, { ...key, version: "1.0.0" }, "Mine.", 1)],
    ["deprecation", (key) => setDeprecated(market.db, { ...key, version: "1.0.0" }, "Old.", 1)],
  ];

  it.each(writes)("changes nothing on the entry: %s", async (label, write) => {
    const key = await movedEntry(`moved-${label.replace(" ", "-")}`);
    const before = await entryRow(key.name);
    const versionBefore = await versionRow(key.name);
    expect(await write(key)).toBe(false);
    expect(await entryRow(key.name)).toEqual(before);
    expect(await versionRow(key.name)).toEqual(versionBefore);
  });

  it("records no withdrawal", async () => {
    const key = await movedEntry("moved-withdraw");
    const added = await addWithdrawal(market.db, {
      ...key,
      version: "1.0.0",
      hash: "a".repeat(64),
      reason: "Mine to withdraw.",
      at: 1,
    });
    expect(added).toBe(false);
    expect(await count("pending_withdrawals", key.name)).toBe(0);
  });

  it("files no appeal", async () => {
    const key = await movedEntry("moved-appeal");
    const added = await addAppeal(market.db, {
      id: "apl_race",
      ...key,
      version: "1.0.0",
      note: "Please.",
      replacement: undefined,
      now: 1,
    });
    expect(added).toBe(false);
    expect(await count("appeals", key.name)).toBe(0);
  });

  it("offers no transfer", async () => {
    const key = await movedEntry("moved-offer");
    const offer = await offerTransfer(market.db, {
      id: "trf_race",
      entry: { type: "spade-skill", name: key.name },
      from: maker.id,
      to: taker.id,
      now: 1,
    });
    expect(offer).toBeUndefined();
    expect(await count("transfers", key.name)).toBe(0);
  });

  it("pins nothing", async () => {
    const key = await movedEntry("moved-pin");
    expect(await setPins(market.db, maker.id, [{ type: "spade-skill", name: key.name }])).toBe(
      false,
    );
    const pins = await market.db
      .prepare("SELECT pins FROM publishers WHERE id = ?1")
      .bind(maker.id)
      .first<{ pins: string }>();
    expect(JSON.parse(pins?.pins ?? "[]")).toEqual([]);
  });

  it("deletes nothing", async () => {
    await market.db
      .prepare(
        `INSERT INTO entries (type, name, publisher, title) VALUES ('spade-skill', 'moved-delete', ?1,
          'moved-delete')`,
      )
      .bind(taker.id)
      .run();
    const outcome = await deleteNeverListed(market.db, noBucket, {
      type: "spade-skill",
      name: "moved-delete",
      publisher: maker.id,
    });
    expect(outcome).toBe("not-yours");
    expect((await entryRow("moved-delete"))?.publisher).toBe(taker.id);
  });
});

describe("deleting an entry that was never listed", () => {
  it("keeps its submitted bytes for a publication that names the same hash", async () => {
    const upload = skill("reused-bytes");
    const published = await draftAndPublish(market, "acct_race_maker", upload);
    expect(published.status).toBe(201);
    const { hash } = await jsonOf<{ hash: string }>(published);
    const stored = await market.db
      .prepare("SELECT size, published FROM versions WHERE name = 'reused-bytes'")
      .first<{ size: number; published: number }>();
    const deleted = await asAccount(
      market,
      "acct_race_maker",
      "DELETE",
      "/v1/me/entries/spade-skill/reused-bytes",
    );
    expect(deleted.status).toBe(200);
    // A publish that found objects/<hash> already there stores its version after the delete.
    await storePending(market.db, {
      publisher: maker.id,
      type: "spade-skill",
      name: "reused-bytes",
      version: "1.0.0",
      hash,
      size: stored?.size ?? 0,
      published: stored?.published ?? 0,
      listing: { title: "reused-bytes", line: "", description: "", categories: [], keywords: [] },
    });
    await sign(market, upload, { id: maker.id, name: maker.handle });
    expect((await market.fetch(`/v1/objects/${hash}`)).status).toBe(200);
  });
});

describe("two renames from the same handle", () => {
  it("the second one, read before the first landed, fails and leaves no handle unretired", async () => {
    const renamer = await establishedPublisher(market, "acct_race_renamer", "race-renamer");
    const before = { id: renamer.id, name: "race-renamer", skeleton: skeleton("race-renamer") };
    const first = await changeHandle(
      market.db,
      before,
      { handle: "race-first", skeleton: skeleton("race-first") },
      1,
    );
    const second = await changeHandle(
      market.db,
      before,
      { handle: "race-second", skeleton: skeleton("race-second") },
      2,
    );
    expect([first, second]).toEqual(["moved", "stale"]);
    const row = await market.db
      .prepare("SELECT name FROM publishers WHERE id = ?1")
      .bind(renamer.id)
      .first<{ name: string }>();
    expect(row?.name).toBe("race-first");
    const response = await asAccount(market, "acct_race_other", "POST", "/v1/me/profile", {
      handle: "race-renamer",
      displayName: "Someone else",
    });
    expect(response.status).toBe(409);
  });
});
