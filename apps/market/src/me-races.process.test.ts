import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skeleton } from "@ace/marketplace/profile";
import { sampleSkill } from "@ace/marketplace/testing";
import { asSigner, publish, startMarket, type Market } from "./testing/harness.ts";
import {
  asAccount,
  createDraft,
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
import { writeDraft } from "./store/drafts.ts";
import { reserveUpload } from "./store/me-limits.ts";
import { addAppeal, offerTransfer } from "./store/me-transfers.ts";
import { changeHandle, createProfile, setPins } from "./store/profiles.ts";
import { addWithdrawal, claimPublisher, storePending } from "./store/publish.ts";
import { dueRechecks, recordCheck } from "./store/verification.ts";

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
    await storePending(
      market.db,
      {
        publisher: maker.id,
        type: "spade-skill",
        name: "reused-bytes",
        version: "1.0.0",
        hash,
        size: stored?.size ?? 0,
        published: stored?.published ?? 0,
        listing: { title: "reused-bytes", line: "", description: "", categories: [], keywords: [] },
      },
      { quotaBytes: 1024 * 1024 * 1024 },
    );
    await sign(market, upload, { id: maker.id, name: maker.handle });
    expect((await market.fetch(`/v1/objects/${hash}`)).status).toBe(200);
  });
});

describe("two renames from the same handle", () => {
  it("the second one, read before the first landed, fails and leaves no handle unretired", async () => {
    const renamer = await establishedPublisher(market, "acct_race_renamer", "race-renamer");
    const before = { id: renamer.id, name: "race-renamer", skeleton: skeleton("race-renamer") };
    const first = await changeHandle(market.db, before, {
      handle: "race-first",
      skeleton: skeleton("race-first"),
    });
    const second = await changeHandle(market.db, before, {
      handle: "race-second",
      skeleton: skeleton("race-second"),
    });
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

const proofsOfPublisher = async (id: string) =>
  JSON.parse(
    (
      await market.db
        .prepare("SELECT proofs FROM publishers WHERE id = ?1")
        .bind(id)
        .first<{ proofs: string }>()
    )?.proofs ?? "[]",
  ) as unknown[];
const tokenOf = async (id: string, kind: string) =>
  (
    await market.db
      .prepare("SELECT token FROM verification_challenges WHERE publisher = ?1 AND kind = ?2")
      .bind(id, kind)
      .first<{ token: string }>()
  )?.token ?? "";

describe("verification checks", () => {
  it("two checks that pass at once both keep their proof", async () => {
    const applicant = await establishedPublisher(market, "acct_race_proofs", "race-proofs");
    const applied = await asAccount(market, "acct_race_proofs", "POST", "/v1/me/verification", {
      domain: "proofs.example",
      github: "proofs-org",
    });
    expect(applied.status).toBe(200);
    const now = Date.now();
    // Each request read the publisher before the other wrote.
    await Promise.all([
      recordCheck(
        market.db,
        applicant.id,
        { token: await tokenOf(applicant.id, "domain") },
        { passed: { kind: "domain", domain: "proofs.example", via: "dns" } },
        now,
      ),
      recordCheck(
        market.db,
        applicant.id,
        { token: await tokenOf(applicant.id, "github") },
        { passed: { kind: "github", login: "proofs-org", via: "gist" } },
        now,
      ),
    ]);
    expect(await proofsOfPublisher(applicant.id)).toEqual(
      expect.arrayContaining([
        { kind: "account" },
        { kind: "domain", domain: "proofs.example", via: "dns" },
        { kind: "github", login: "proofs-org", via: "gist" },
      ]),
    );
  });

  it("a verified publisher who applies again is still re-checked on the domain it was verified on", async () => {
    const verified = await establishedPublisher(market, "acct_race_verified", "race-reapplier");
    const approved = [
      { kind: "account" },
      { kind: "domain", domain: "approved.example", via: "dns" },
    ];
    await market.db.batch([
      market.db
        .prepare(
          `UPDATE publishers SET verified = 1, verification = 'verified', proofs = ?2,
            approved_proofs = ?2, rechecked = 0 WHERE id = ?1`,
        )
        .bind(verified.id, JSON.stringify(approved)),
      market.db
        .prepare(
          `INSERT INTO verification_challenges (publisher, kind, subject, token, expires, state)
            VALUES (?1, 'domain', 'approved.example', 'approved-token', 0, 'passed')`,
        )
        .bind(verified.id),
    ]);
    const applied = await asAccount(market, "acct_race_verified", "POST", "/v1/me/verification", {
      domain: "new.example",
    });
    expect(applied.status).toBe(200);
    const status = await jsonOf<{ challenges: { subject: string; state: string }[] }>(applied);
    expect(status.challenges).toEqual([
      expect.objectContaining({ subject: "new.example", state: "waiting" }),
    ]);
    const due = (await dueRechecks(market.db, Date.now(), 1000)).filter(
      (row) => row.publisher === verified.id,
    );
    expect(due).toEqual([
      { publisher: verified.id, domain: "approved.example", token: "approved-token" },
    ]);
    // The new domain passing is a new application; the proofs the mark was granted on stay.
    const fresh = { kind: "domain", domain: "new.example", via: "dns" } as const;
    await recordCheck(
      market.db,
      verified.id,
      { token: await tokenOf(verified.id, "domain") },
      { passed: fresh },
      Date.now(),
    );
    expect(await proofsOfPublisher(verified.id)).toEqual([{ kind: "account" }, fresh]);
    const applying = await jsonOf<{ state: string; verified: boolean; proofs: unknown[] }>(
      await asAccount(market, "acct_race_verified", "GET", "/v1/me/verification"),
    );
    expect(applying).toMatchObject({
      state: "applied",
      verified: true,
      proofs: [{ kind: "account" }, fresh],
    });
    const queue = await jsonOf<{
      verifications: { publisher: { id: string }; proofs: unknown[] }[];
    }>(await market.fetch("/v1/signer/queue", { headers: asSigner }));
    expect(queue.verifications.find((item) => item.publisher.id === verified.id)?.proofs).toEqual([
      { kind: "account" },
      fresh,
    ]);
    const profile = await jsonOf<{ profile: { verified: boolean; proofs: unknown[] } }>(
      await market.fetch("/v1/publishers/race-reapplier"),
    );
    expect(profile.profile).toEqual(expect.objectContaining({ verified: true, proofs: approved }));
    expect(
      (await dueRechecks(market.db, Date.now(), 1000)).filter(
        (row) => row.publisher === verified.id,
      ),
    ).toEqual([{ publisher: verified.id, domain: "approved.example", token: "approved-token" }]);
  });
});

/** Rows for `n` drafts of the publisher's, as earlier uploads left them. */
async function fillDrafts(publisher: string, n: number) {
  await market.db.batch(
    Array.from({ length: n }, (_, index) =>
      market.db
        .prepare(
          `INSERT INTO drafts (id, publisher, type, name, version, hash, size, files, title,
              scan_state, created, updated)
            VALUES (?1, ?2, 'spade-skill', ?1, '1.0.0', ?3, 10, 1, ?1, 'done', 1, 1)`,
        )
        .bind(`drf_${publisher}_${index}`, publisher, "e".repeat(64)),
    ),
  );
}
const draftCount = async (publisher: string) =>
  (
    await market.db
      .prepare("SELECT COUNT(*) AS n FROM drafts WHERE publisher = ?1")
      .bind(publisher)
      .first<{ n: number }>()
  )?.n;
const caps = { quotaBytes: 1024 * 1024 * 1024, draftLimit: 20 };
const draftWrite = (publisher: string, id: string) => ({
  id,
  publisher,
  type: "spade-skill" as const,
  name: id,
  version: "1.0.0",
  hash: "d".repeat(64),
  size: 10,
  files: 1,
  title: id,
  problems: [],
  now: 1,
});

describe("upload limits under concurrent uploads", () => {
  it("two new drafts for the last slot: one is written", async () => {
    const owner = await establishedPublisher(market, "acct_race_slots", "race-slots");
    await fillDrafts(owner.id, 19);
    const written = await Promise.all(
      ["drf_slot_a", "drf_slot_b"].map((id) =>
        writeDraft(market.db, draftWrite(owner.id, id), { done: true, verdict: "pass" }, caps),
      ),
    );
    expect(written.toSorted()).toEqual([false, true]);
    expect(await draftCount(owner.id)).toBe(20);
  });

  it("two drafts that each fit the quota alone: only one is written", async () => {
    const owner = await establishedPublisher(market, "acct_race_bytes", "race-bytes");
    const small = { quotaBytes: 15, draftLimit: 20 };
    const written = await Promise.all(
      ["drf_bytes_a", "drf_bytes_b"].map((id) =>
        writeDraft(market.db, draftWrite(owner.id, id), { done: true, verdict: "pass" }, small),
      ),
    );
    expect(written.toSorted()).toEqual([false, true]);
  });

  it("two uploads for the last of the day's uploads: one is counted", async () => {
    const owner = await establishedPublisher(market, "acct_race_daily", "race-daily");
    const now = Date.now();
    await market.db
      .prepare("INSERT INTO upload_days (publisher, day, count) VALUES (?1, ?2, 29)")
      .bind(owner.id, Math.floor(now / 86_400_000))
      .run();
    const reservation = { publisher: owner.id, newPublisher: false, size: 10, now };
    const refusals = await Promise.all([
      reserveUpload(market.db, { ...reservation, newDraft: false }),
      reserveUpload(market.db, { ...reservation, newDraft: false }),
    ]);
    expect(refusals.filter((refusal) => refusal === undefined)).toHaveLength(1);
    expect(refusals.find((refusal) => refusal !== undefined)).toMatch(/30 times a day/);
  });

  it("a CLI upload whose scan carries on as a draft keeps to the draft cap", async () => {
    const owner = await establishedPublisher(market, "acct_race_cli", "race-cli");
    await fillDrafts(owner.id, 20);
    const big = "words ".repeat(180_000);
    const response = await publish(market, {
      type: "spade-skill",
      name: "race-cli-big",
      account: "acct_race_cli",
      files: sampleSkill("race-cli-big", {
        "a.md": big,
        "b.md": big,
        "c.md": big,
        "d.md": big,
        "e.md": big,
      }),
    });
    expect(response.status).toBe(429);
    expect(await response.text()).toMatch(/20 drafts/);
    expect(await draftCount(owner.id)).toBe(20);
  });
});

describe("publishing a draft", () => {
  it("isn't published when the draft names other bytes than its scan read", async () => {
    await establishedPublisher(market, "acct_race_draft", "race-draft");
    const created = await createDraft(market, "acct_race_draft", skill("race-swapped"));
    expect(created.status).toBe(201);
    const { id } = await jsonOf<{ id: string }>(created);
    // A replace on its way has written the row; its bytes and report haven't landed yet.
    await market.db
      .prepare("UPDATE drafts SET hash = ?2 WHERE id = ?1")
      .bind(id, "f".repeat(64))
      .run();
    const published = await asAccount(
      market,
      "acct_race_draft",
      "POST",
      `/v1/me/drafts/${id}/publish`,
    );
    expect(published.status).toBe(409);
    expect(await count("versions", "race-swapped")).toBe(0);
  });

  it("stores no version once the draft holds other bytes", async () => {
    const owner = await establishedPublisher(market, "acct_race_guard", "race-guard");
    await writeDraft(
      market.db,
      draftWrite(owner.id, "drf_guarded"),
      { done: true, verdict: "pass" },
      caps,
    );
    const stored = await storePending(
      market.db,
      {
        publisher: owner.id,
        type: "spade-skill",
        name: "drf_guarded",
        version: "1.0.0",
        hash: "c".repeat(64),
        size: 10,
        published: 1,
        listing: { title: "guarded", line: "", description: "", categories: [], keywords: [] },
      },
      { quotaBytes: caps.quotaBytes, draft: "drf_guarded" },
    );
    expect(stored.written).toBe(false);
    expect(await count("versions", "drf_guarded")).toBe(0);
    expect(await count("entries", "drf_guarded")).toBe(0);
  });
});

describe("claims of one handle", () => {
  const claim = (account: string, handle: string) =>
    createProfile(market.db, {
      id: `pub_${account}`,
      account,
      handle,
      skeleton: skeleton(handle),
      displayName: handle,
      bio: "",
      links: [],
      now: 1,
    });

  it("two accounts claiming the same handle at once: one gets it", async () => {
    const outcomes = await Promise.all([
      claim("acct_race_claim_a", "race-claimed"),
      claim("acct_race_claim_b", "race-claimed"),
    ]);
    expect(outcomes.toSorted()).toEqual([false, true]);
  });

  it("a handle another account gave up stays theirs, even to a claim that checked before", async () => {
    const giver = await establishedPublisher(market, "acct_race_giver", "race-given");
    // The claims below passed their handle check before this rename retired the handle.
    expect(
      await changeHandle(
        market.db,
        { id: giver.id, name: "race-given" },
        { handle: "race-kept", skeleton: skeleton("race-kept") },
      ),
    ).toBe("moved");
    expect(await claim("acct_race_late", "race-given")).toBe(false);
    await expect(
      claimPublisher(market.db, {
        id: "pub_race_first_publish",
        account: "acct_race_first_publish",
        name: "race-given",
        skeleton: skeleton("race-given"),
        now: 1,
      }),
    ).rejects.toThrow(/UNIQUE/);
    expect(
      await changeHandle(
        market.db,
        { id: taker.id, name: taker.handle },
        { handle: "race-given", skeleton: skeleton("race-given") },
      ),
    ).toBe("taken");
    // The account that gave it up takes it back.
    expect(
      await changeHandle(
        market.db,
        { id: giver.id, name: "race-kept" },
        { handle: "race-given", skeleton: skeleton("race-given") },
      ),
    ).toBe("moved");
  });
});
