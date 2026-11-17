import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleSkill } from "@ace/marketplace/testing";
import { draftKey } from "./context.ts";
import { publish, put, startMarket, type Market, catalogueOf } from "./testing/harness.ts";
import { approve, publishLive, verifiedBy } from "./testing/discover-harness.ts";
import {
  asAccount,
  createDraft,
  establishedPublisher,
  jsonOf,
} from "./testing/publisher-harness.ts";
import { writeArchive } from "@ace/marketplace";
import { computeEntry, readEntrySnapshot, writeEntry } from "./store/entries.ts";
import { listVersion, versionForSigning } from "./store/signer.ts";

/*
 * Races between a request's read and its write in the signer's routes, the signed lists and
 * drafts (ADR 0173 §5, §8, §13): each case leaves D1 and R2 as the other request would have and
 * then lets the first one finish.
 */

let market: Market;

beforeAll(async () => {
  market = await startMarket();
}, 60_000);
afterAll(() => market.close());

const skill = (name: string, files = sampleSkill(name)) => ({
  type: "spade-skill" as const,
  name,
  files,
});

/** The stored verified list's `issued`, undefined while none is stored. */
const storedList = async () => {
  const response = await market.fetch("/v1/verified");
  if (response.status !== 200) {
    await response.body?.cancel();
    return undefined;
  }
  return ((await response.json()) as { body: { issued: number } }).body.issued;
};

const publisherId = async (handle: string) =>
  (
    await market.dbs.publishers
      .prepare("SELECT id FROM publishers WHERE name = ?1")
      .bind(handle)
      .first<{ id: string }>()
  )?.id ?? "";

/** The same JSON value with every object's properties in the opposite order. */
const reordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reordered)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .toReversed()
            .map(([key, entry]) => [key, reordered(entry)]),
        )
      : value;

describe("a signature checked against one submission", () => {
  it("doesn't list the version once it was blocked and submitted again with other bytes", async () => {
    const upload = skill("signed-then-swapped");
    expect((await publish(market, upload)).status).toBe(201);
    await approve(market, upload);
    const key = { type: "spade-skill", name: upload.name, version: "1.0.0" };
    const read = await versionForSigning(catalogueOf(market, "spade-skill"), key);
    if (!read) throw new Error("no version");
    // Before the signature lands, the version is blocked and its publisher submits other bytes.
    await catalogueOf(market, "spade-skill")
      .prepare(
        `UPDATE versions SET hash = ?2, size = size + 1, state = 'pending'
          WHERE type = 'spade-skill' AND name = ?1`,
      )
      .bind(upload.name, "b".repeat(64))
      .run();
    const signed = { manifest: '{"signed":"A"}', hash: read.hash, size: read.size };
    expect(
      await listVersion(
        catalogueOf(market, "spade-skill"),
        key,
        { ...signed, publisher: read.publisher.id },
        Date.now(),
      ),
    ).toBe(false);
    expect(
      await catalogueOf(market, "spade-skill")
        .prepare(
          `SELECT v.listed, v.state, v.manifest, p.live_versions FROM versions v
            JOIN entries e ON e.type = v.type AND e.name = v.name
            JOIN publisher_copies p ON p.id = e.publisher WHERE v.name = ?1`,
        )
        .bind(upload.name)
        .first(),
    ).toEqual({ listed: 0, state: "pending", manifest: null, live_versions: 0 });
  });
});

describe("the verified list", () => {
  it("an entry refresh that read the publisher verified can't mark it verified after the mark goes", async () => {
    await publishLive(market, {
      ...skill("mark-race"),
      account: "acct_mark",
      publisher: "mark-folk",
    });
    const id = await publisherId("mark-folk");
    const basedOn = await storedList();
    const issued = basedOn ?? 0;
    const on = verifiedBy({
      issued: issued + 1,
      publishers: [{ id, handle: "mark-folk", proofs: [{ kind: "account" }], at: 5 }],
    });
    expect((await put(market, "/v1/signer/verified", { verified: on, basedOn })).status).toBe(200);
    // A refresh reads the entry while its publisher is verified, then is overtaken.
    await catalogueOf(market, "spade-skill")
      .prepare("UPDATE entries SET verified = 0 WHERE name = 'mark-race'")
      .run();
    const snapshot = await readEntrySnapshot(
      catalogueOf(market, "spade-skill"),
      "spade-skill",
      "mark-race",
    );
    if (!snapshot) throw new Error("no entry");
    const stale = computeEntry("mark-race", snapshot.versions, snapshot.manage);
    expect(stale.verified).toBe(true);
    const off = verifiedBy({ issued: issued + 2, publishers: [] });
    const revoked = [{ handle: "mark-folk", reason: "Lapsed" }];
    expect(
      (await put(market, "/v1/signer/verified", { verified: off, basedOn: issued + 1, revoked }))
        .status,
    ).toBe(200);
    expect(
      await writeEntry(
        catalogueOf(market, "spade-skill"),
        "spade-skill",
        "mark-race",
        stale,
        snapshot.generation,
        Date.now(),
      ),
    ).toBe(false);
    expect(
      await catalogueOf(market, "spade-skill")
        .prepare("SELECT verified FROM entries WHERE name = 'mark-race'")
        .first(),
    ).toEqual({ verified: 0 });
  });

  it("the same list sent again with its properties in another order is stored and repairs entries", async () => {
    await publishLive(market, {
      ...skill("order-race"),
      account: "acct_order",
      publisher: "order-folk",
    });
    const id = await publisherId("order-folk");
    const basedOn = await storedList();
    const issued = basedOn ?? 0;
    const on = verifiedBy({
      issued: issued + 1,
      publishers: [{ id, handle: "order-folk", proofs: [{ kind: "account" }], at: 5 }],
    });
    const upload = { verified: on, basedOn };
    expect((await put(market, "/v1/signer/verified", upload)).status).toBe(200);
    // Cut off after the publisher was marked but before its entries were refreshed: the copy's
    // sync never finished. Sent again, as another tool writes JSON.
    await catalogueOf(market, "spade-skill")
      .prepare("UPDATE entries SET verified = 0 WHERE name = 'order-race'")
      .run();
    await market.dbs.publishers
      .prepare("UPDATE publishers SET synced = 0 WHERE id = ?1")
      .bind(id)
      .run();
    const again = await put(market, "/v1/signer/verified", reordered(upload));
    expect(again.status).toBe(200);
    expect(
      await catalogueOf(market, "spade-skill")
        .prepare("SELECT verified FROM entries WHERE name = 'order-race'")
        .first(),
    ).toEqual({ verified: 1 });
  });
});

describe("two replacements of one draft", () => {
  it("whichever bytes land last, the draft publishes the revision its row names", async () => {
    await establishedPublisher(market, "acct_drafts", "draft-folk");
    const first = skill("twice-replaced", sampleSkill("twice-replaced", { "v.md": "first" }));
    const created = await createDraft(market, "acct_drafts", first);
    expect(created.status).toBe(201);
    const draft = await jsonOf<{ id: string; hash: string }>(created);
    const second = sampleSkill("twice-replaced", { "v.md": "second" });
    const replaced = await asAccount(
      market,
      "acct_drafts",
      "PUT",
      `/v1/me/drafts/${draft.id}`,
      writeArchive(second),
    );
    expect(replaced.status).toBe(200);
    const now = await jsonOf<{ hash: string }>(replaced);
    expect(now.hash).not.toBe(draft.hash);
    // The other replace wrote its row first, and its bytes land only now.
    await market.objects.put(draftKey(draft.id, draft.hash), writeArchive(first.files));
    const published = await asAccount(
      market,
      "acct_drafts",
      "POST",
      `/v1/me/drafts/${draft.id}/publish`,
    );
    expect(published.status).toBe(201);
    expect(
      await catalogueOf(market, "spade-skill")
        .prepare("SELECT hash FROM versions WHERE name = 'twice-replaced'")
        .first(),
    ).toEqual({ hash: now.hash });
    // Publishing removed every revision of the draft.
    expect((await market.objects.list({ prefix: `drafts/${draft.id}/` })).objects).toEqual([]);
  });

  it("a replace keeps only the revision the row names", async () => {
    const created = await createDraft(market, "acct_drafts", skill("replaced-once"));
    const draft = await jsonOf<{ id: string }>(created);
    const replaced = await asAccount(
      market,
      "acct_drafts",
      "PUT",
      `/v1/me/drafts/${draft.id}`,
      writeArchive(sampleSkill("replaced-once", { "v.md": "again" })),
    );
    const row = await jsonOf<{ hash: string }>(replaced);
    expect(
      (await market.objects.list({ prefix: `drafts/${draft.id}/` })).objects.map((o) => o.key),
    ).toEqual([draftKey(draft.id, row.hash)]);
  });
});
