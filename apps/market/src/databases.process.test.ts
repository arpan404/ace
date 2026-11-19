import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skeleton } from "@ace/marketplace/profile";
import { samplePlugin, sampleSkill, sampleSuit, signedWithdrawn } from "@ace/marketplace/testing";
import {
  catalogueOf,
  marketKey,
  publish,
  put,
  startMarket,
  type Market,
} from "./testing/harness.ts";
import { download, publishLive } from "./testing/discover-harness.ts";
import {
  asAccount,
  createDraft,
  establishedPublisher,
  jsonOf,
} from "./testing/publisher-harness.ts";
import { applyCopy, copyOf } from "./store/copies.ts";
import { claimDraft } from "./store/drafts.ts";
import { chargeItem, reserveUpload } from "./store/me-limits.ts";
import { changeHandle } from "./store/profiles.ts";
import { storePending } from "./store/publish.ts";
import { chargeGraceMs, reconcileUsage } from "./store/usage.ts";

/*
 * The market across its databases (ADR 0174 §16): each type's entries stay in its own
 * catalogue, `since` stays exact over several stamps, and every protocol that spans two
 * databases finishes after a cut-off at any step, through a retry or the cron.
 */

let market: Market;
beforeAll(async () => {
  market = await startMarket();
}, 60_000);
afterAll(() => market.close());

type Index = {
  stamp: number;
  entries: { type: string; name: string; publisher: { name: string }; downloads: number }[];
  removed: unknown[];
};
const index = async (since?: number) =>
  jsonOf<Index>(await market.fetch(since === undefined ? "/v1/index" : `/v1/index?since=${since}`));
const keys = (body: Index) => body.entries.map((entry) => `${entry.type}/${entry.name}`);
const rowsNamed = async (name: string) =>
  Object.fromEntries(
    await Promise.all(
      market.dbs.catalogues.map(async ({ type, db }) => {
        const row = await db
          .prepare("SELECT COUNT(*) AS n FROM entries WHERE name = ?1")
          .bind(name)
          .first<{ n: number }>();
        return [type, row?.n ?? 0];
      }),
    ),
  );

describe("routing", () => {
  it("a suit and a skill of one name are two entries, each only in its type's catalogue", async () => {
    await publishLive(market, {
      type: "suit",
      name: "harbour-dusk",
      files: sampleSuit("harbour-dusk"),
      account: "acct_route",
      publisher: "route-folk",
    });
    await publishLive(market, {
      type: "spade-skill",
      name: "harbour-dusk",
      files: sampleSkill("harbour-dusk"),
      account: "acct_route",
      publisher: "route-folk",
    });
    expect(await rowsNamed("harbour-dusk")).toEqual({
      "spade-bot": 0,
      "spade-plugin": 0,
      "spade-skill": 1,
      suit: 1,
    });
    const suitVersion = await catalogueOf(market, "suit")
      .prepare("SELECT type FROM versions WHERE name = 'harbour-dusk'")
      .all<{ type: string }>();
    expect(suitVersion.results).toEqual([{ type: "suit" }]);
    expect(keys(await index())).toEqual(
      expect.arrayContaining(["spade-skill/harbour-dusk", "suit/harbour-dusk"]),
    );
  });

  it("a type the market holds no catalogue for is refused and writes nothing anywhere", async () => {
    const refused = await publish(market, {
      type: "ace-plugin",
      name: "no-home",
      files: samplePlugin("no-home"),
      account: "acct_nohome",
      publisher: "no-home-folk",
    });
    expect(refused.status).toBe(404);
    expect(await rowsNamed("no-home")).toEqual({
      "spade-bot": 0,
      "spade-plugin": 0,
      "spade-skill": 0,
      suit: 0,
    });
    const publisher = await market.dbs.publishers
      .prepare("SELECT 1 FROM publishers WHERE name = 'no-home-folk'")
      .first();
    expect(publisher).toBeNull();
    expect((await market.fetch("/v1/entries/ace-plugin/no-home")).status).toBe(404);
  });
});

describe("since across catalogues", () => {
  it("answers each catalogue's changes once, and a quiet catalogue's next change too", async () => {
    const start = await index();
    await publishLive(market, {
      type: "spade-plugin",
      name: "delta-tools",
      files: samplePlugin("delta-tools"),
      account: "acct_delta",
      publisher: "delta-folk",
    });
    const first = await index(start.stamp);
    expect(keys(first)).toEqual(["spade-plugin/delta-tools"]);
    // The plugins catalogue moved on; the others were raised to its stamp, so nothing comes
    // again from any of them.
    expect(first.stamp).toBeGreaterThan(start.stamp);
    expect(keys(await index(first.stamp))).toEqual([]);
    for (const { db } of market.dbs.catalogues) {
      const stamp = await db.prepare("SELECT value FROM meta WHERE key = 'stamp'").first<{
        value: number;
      }>();
      expect(stamp?.value).toBeGreaterThanOrEqual(first.stamp);
    }
    // A catalogue that was quiet changes next: its change is above the stamp handed out.
    await publishLive(market, {
      type: "suit",
      name: "delta-dusk",
      files: sampleSuit("delta-dusk"),
      account: "acct_delta",
      publisher: "delta-folk",
    });
    const second = await index(first.stamp);
    expect(keys(second)).toEqual(["suit/delta-dusk"]);
    expect(keys(await index(second.stamp))).toEqual([]);
  });
});

describe("a protocol cut off part way", () => {
  it("a rename that reached one catalogue's copy reaches the rest through the cron", async () => {
    const owner = await establishedPublisher(market, "acct_rename", "old-name");
    await publishLive(market, {
      type: "suit",
      name: "rename-dusk",
      files: sampleSuit("rename-dusk"),
      account: "acct_rename",
    });
    await publishLive(market, {
      type: "spade-skill",
      name: "rename-skill",
      files: sampleSkill("rename-skill"),
      account: "acct_rename",
    });
    const before = await index();
    // The rename lands and its copy reaches the suits catalogue; the request dies before the rest.
    expect(
      await changeHandle(
        market.dbs.publishers,
        { id: owner.id, name: "old-name" },
        { handle: "new-name", skeleton: skeleton("new-name") },
      ),
    ).toBe("moved");
    const copy = await copyOf(market.dbs.publishers, owner.id);
    if (!copy) throw new Error("no publisher");
    await applyCopy(catalogueOf(market, "suit"), copy, Date.now());
    const handles = async () =>
      Object.fromEntries(
        (await index()).entries
          .filter((entry) => entry.name.startsWith("rename-"))
          .map((entry) => [entry.name, entry.publisher.name]),
      );
    expect(await handles()).toEqual({ "rename-dusk": "new-name", "rename-skill": "old-name" });

    await market.scheduled();
    expect(await handles()).toEqual({ "rename-dusk": "new-name", "rename-skill": "new-name" });
    // `since` readers get both entries with the new handle.
    expect(keys(await index(before.stamp))).toEqual(
      expect.arrayContaining(["spade-skill/rename-skill", "suit/rename-dusk"]),
    );
    const synced = await market.dbs.publishers
      .prepare("SELECT synced = revision AS done FROM publishers WHERE id = ?1")
      .bind(owner.id)
      .first<{ done: number }>();
    expect(synced?.done).toBe(1);
  });

  it("a withdrawn list one catalogue never marked is marked by the cron", async () => {
    const suit = await publishLive(market, {
      type: "suit",
      name: "withdrawn-dusk",
      files: sampleSuit("withdrawn-dusk"),
      account: "acct_pull",
      publisher: "pull-folk",
    });
    const skill = await publishLive(market, {
      type: "spade-skill",
      name: "withdrawn-skill",
      files: sampleSkill("withdrawn-skill"),
      account: "acct_pull",
      publisher: "pull-folk",
    });
    const list = signedWithdrawn(
      [
        {
          hash: suit.hash,
          reason: "Pulled",
          type: "suit",
          name: "withdrawn-dusk",
          version: "1.0.0",
        },
        {
          hash: skill.hash,
          reason: "Pulled",
          type: "spade-skill",
          name: "withdrawn-skill",
          version: "1.0.0",
        },
      ],
      { key: marketKey, issued: 1_900_000_000_000 },
    );
    expect((await put(market, "/v1/signer/withdrawn", { withdrawn: list })).status).toBe(200);
    // As if the upload stopped after the lists database and the skills catalogue.
    await catalogueOf(market, "suit").batch([
      catalogueOf(market, "suit").prepare("DELETE FROM applied_lists"),
      catalogueOf(market, "suit").prepare(
        "UPDATE versions SET withdrawn = NULL WHERE name = 'withdrawn-dusk'",
      ),
    ]);
    const withdrawn = async (type: string, name: string) =>
      (
        await jsonOf<{ versions: { withdrawn?: string }[] }>(
          await market.fetch(`/v1/entries/${type}/${name}`),
        )
      ).versions[0]?.withdrawn;
    expect(await withdrawn("suit", "withdrawn-dusk")).toBeUndefined();
    expect(await withdrawn("spade-skill", "withdrawn-skill")).toBe("Pulled");

    await market.scheduled();
    expect(await withdrawn("suit", "withdrawn-dusk")).toBe("Pulled");
    // Applying an older list late changes nothing.
    const older = signedWithdrawn([], { key: marketKey, issued: 1_800_000_000_000 });
    expect((await put(market, "/v1/signer/withdrawn", { withdrawn: older })).status).toBe(409);
    expect(await withdrawn("suit", "withdrawn-dusk")).toBe("Pulled");
  });

  it("a fold cut off before it was marked folds the same totals again and restamps nothing", async () => {
    const live = await publishLive(market, {
      type: "spade-skill",
      name: "fold-skill",
      files: sampleSkill("fold-skill"),
      account: "acct_fold",
      publisher: "fold-folk",
    });
    await download(market, live.hash, "192.0.2.201");
    await download(market, live.hash, "192.0.2.202");
    const counted = async () =>
      (
        await market.dbs.counts
          .prepare("SELECT downloads FROM version_totals WHERE name = 'fold-skill'")
          .first<{ downloads: number }>()
      )?.downloads;
    await expect.poll(counted).toBe(2);
    await market.scheduled();
    const folded = await index();
    expect(folded.entries.find((entry) => entry.name === "fold-skill")?.downloads).toBe(2);
    // The catalogue took the totals; the counts database never marked them folded.
    await market.dbs.counts
      .prepare("UPDATE version_totals SET folded = 0 WHERE name = 'fold-skill'")
      .run();
    await market.scheduled();
    expect(keys(await index(folded.stamp))).not.toContain("spade-skill/fold-skill");
    expect((await index()).entries.find((entry) => entry.name === "fold-skill")?.downloads).toBe(2);
  });

  it("a publish cut off after claiming its draft: the draft holds still, and a retry finishes it", async () => {
    const owner = await establishedPublisher(market, "acct_claim", "claim-folk");
    const upload = {
      type: "spade-skill" as const,
      name: "claimed-skill",
      files: sampleSkill("claimed-skill"),
    };
    const draft = await jsonOf<{ id: string; hash: string }>(
      await createDraft(market, "acct_claim", upload),
    );
    const item = chargeItem({ ...upload, version: "1.0.0" });
    expect(
      await claimDraft(
        market.dbs.publishers,
        { id: draft.id, hash: draft.hash, publisher: owner.id },
        item,
        Date.now(),
      ),
    ).toBe(true);
    const path = `/v1/me/drafts/${draft.id}`;
    expect((await asAccount(market, "acct_claim", "PATCH", path, { changelog: "x" })).status).toBe(
      409,
    );
    expect((await asAccount(market, "acct_claim", "DELETE", path)).status).toBe(409);
    // Its bytes count once, on the version's charge.
    const me = await jsonOf<{ limits: { storedBytes: number } }>(
      await asAccount(market, "acct_claim", "GET", "/v1/me"),
    );
    const charge = await market.dbs.publishers
      .prepare("SELECT size FROM charges WHERE item = ?1")
      .bind(item)
      .first<{ size: number }>();
    expect(me.limits.storedBytes).toBe(charge?.size);

    const retried = await asAccount(market, "acct_claim", "POST", `${path}/publish`);
    expect(retried.status).toBe(201);
    expect((await asAccount(market, "acct_claim", "GET", path)).status).toBe(404);
  });

  it("the cron finishes a claim whose version was stored and releases one whose wasn't", async () => {
    const owner = await establishedPublisher(market, "acct_stale", "stale-folk");
    const make = async (name: string) => {
      const upload = { type: "spade-skill" as const, name, files: sampleSkill(name) };
      const draft = await jsonOf<{ id: string; hash: string }>(
        await createDraft(market, "acct_stale", upload),
      );
      const item = chargeItem({ ...upload, version: "1.0.0" });
      await claimDraft(
        market.dbs.publishers,
        { id: draft.id, hash: draft.hash, publisher: owner.id },
        item,
        Date.now() - chargeGraceMs - 60_000,
      );
      return draft;
    };
    const stored = await make("stale-stored");
    const lost = await make("stale-lost");
    // The first publish stored its version before it died; the second died before.
    await storePending(catalogueOf(market, "spade-skill"), {
      publisher: owner.id,
      type: "spade-skill",
      name: "stale-stored",
      version: "1.0.0",
      hash: stored.hash,
      size: 10,
      published: Date.now(),
      listing: { title: "stale", line: "", description: "", categories: [], keywords: [] },
    });
    await market.scheduled();
    const drafts = await market.dbs.publishers
      .prepare("SELECT id, publishing FROM drafts WHERE id IN (?1, ?2)")
      .bind(stored.id, lost.id)
      .all<{ id: string; publishing: string | null }>();
    expect(drafts.results).toEqual([{ id: lost.id, publishing: null }]);
    // The released draft publishes as any other.
    expect(
      (await asAccount(market, "acct_stale", "POST", `/v1/me/drafts/${lost.id}/publish`)).status,
    ).toBe(201);
  });

  it("a version charge whose version never got stored is dropped by the reconcile after its grace", async () => {
    const owner = await establishedPublisher(market, "acct_ledger", "ledger-folk");
    const now = Date.now();
    const item = chargeItem({ type: "spade-skill", name: "never-stored", version: "1.0.0" });
    expect(
      await reserveUpload(market.dbs.publishers, {
        publisher: owner.id,
        tier: "established",
        size: 1234,
        newDraft: false,
        charge: { item, nonce: "nonce-ledger" },
        now,
      }),
    ).toBeUndefined();
    const charged = () =>
      market.dbs.publishers.prepare("SELECT size FROM charges WHERE item = ?1").bind(item).first();
    // Still on its way: kept.
    await reconcileUsage(market.dbs, owner.id, now + 1_000);
    expect(await charged()).toEqual({ size: 1234 });
    await reconcileUsage(market.dbs, owner.id, now + chargeGraceMs + 1_000);
    expect(await charged()).toBeNull();
  });
});

describe("download credit across catalogues", () => {
  it("bytes listed in two catalogues count for both versions and credit the first listed once", async () => {
    const first = await publishLive(market, {
      type: "spade-skill",
      name: "shared-bytes",
      files: sampleSkill("shared-bytes"),
      account: "acct_shared",
      publisher: "shared-folk",
    });
    // The same bytes listed later in another catalogue, as a copy would be.
    const skills = catalogueOf(market, "spade-skill");
    const plugins = catalogueOf(market, "spade-plugin");
    const copy = await skills
      .prepare(
        "SELECT p.id, p.name, p.state, p.verified, p.created, p.revision FROM publisher_copies p JOIN entries e ON e.publisher = p.id WHERE e.name = 'shared-bytes'",
      )
      .first<{
        id: string;
        name: string;
        state: string;
        verified: number;
        created: number;
        revision: number;
      }>();
    if (!copy) throw new Error("no copy");
    await applyCopy(plugins, copy, Date.now());
    await plugins.batch([
      plugins
        .prepare(
          "INSERT INTO entries (type, name, publisher, title, listed) VALUES ('spade-plugin', 'shared-copy', ?1, 'shared-copy', 1)",
        )
        .bind(copy.id),
      plugins
        .prepare(
          `INSERT INTO versions (type, name, version, hash, size, published, listing, listed, state)
            VALUES ('spade-plugin', 'shared-copy', '1.0.0', ?1, 1, ?2, '{}', 1, 'listed')`,
        )
        .bind(first.hash, Date.now() + 60_000),
    ]);
    await download(market, first.hash, "192.0.2.211");
    const totals = async () =>
      (
        await market.dbs.counts
          .prepare(
            `SELECT t.type, t.downloads,
                (SELECT COALESCE(SUM(count), 0) FROM downloads_hourly h
                  WHERE h.type = t.type AND h.name = t.name) AS credited
              FROM version_totals t WHERE t.name IN ('shared-bytes', 'shared-copy') ORDER BY t.type`,
          )
          .all()
      ).results;
    await expect.poll(totals).toEqual([
      { type: "spade-plugin", downloads: 1, credited: 0 },
      { type: "spade-skill", downloads: 1, credited: 1 },
    ]);
  });
});
