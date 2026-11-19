import { afterAll, beforeAll, expect, it } from "vitest";
import { sampleSkill } from "@ace/marketplace/testing";
import { sweepPictures } from "./cron-publishers.ts";
import {
  pictureClaimMs,
  pictureGraceMs,
  pictureLeaseMs,
  reservePicture,
} from "./store/profiles.ts";
import { startMarket, type Market } from "./testing/harness.ts";
import {
  asAccount,
  createDraft,
  establishedPublisher,
  jsonOf,
  liveVersion,
  testPng,
} from "./testing/publisher-harness.ts";
import { writeArchive } from "@ace/marketplace";

const writeArchiveSize = (files: Parameters<typeof writeArchive>[0]) =>
  writeArchive(files).byteLength;

/*
 * Avatars and listing pictures (ADR 0174 §3, §5, §9) against the market's D1 and R2: their bytes
 * count against the publisher's quota, a bad picture slot writes nothing, and the cron collects
 * pictures nothing names once the grace period has passed, never one an upload charged again
 * while the cron was on its way to deleting it.
 */

let market: Market;
let painter: { id: string; handle: string };
beforeAll(async () => {
  market = await startMarket();
  painter = await establishedPublisher(market, "acct_painter", "painter");
}, 60_000);
afterAll(() => market.close());

const avatarOf = async (response: Parameters<typeof jsonOf>[0]) =>
  (await jsonOf<{ avatar: string }>(response)).avatar;
const keys = async (prefix: string) =>
  (await market.objects.list({ prefix })).objects.map((object) => object.key);
const sweep = (now: number, owner: string = crypto.randomUUID()) =>
  sweepPictures({ dbs: market.dbs, OBJECTS: market.objects }, now, owner);

it("an avatar that doesn't fit the publisher's quota is refused and stores nothing", async () => {
  const crowded = await establishedPublisher(market, "acct_crowded", "crowded");
  // Pictures already charged to the publisher fill its 1 GiB quota but for a few bytes.
  await market.dbs.publishers
    .prepare("INSERT INTO pictures (key, publisher, size, at) VALUES ('previews/full', ?1, ?2, 1)")
    .bind(crowded.id, 1024 * 1024 * 1024 - 16)
    .run();
  const before = await keys("avatars/");
  const response = await asAccount(market, "acct_crowded", "PUT", "/v1/me/avatar", testPng(64, 64));
  expect(response.status).toBe(429);
  expect(await keys("avatars/")).toEqual(before);
  const row = await market.dbs.publishers
    .prepare("SELECT avatar FROM publishers WHERE id = ?1")
    .bind(crowded.id)
    .first<{ avatar: string | null }>();
  expect(row?.avatar).toBeNull();
});

it("a replaced avatar's bytes are collected once the grace period has passed, the new one kept", async () => {
  const first = await avatarOf(
    await asAccount(market, "acct_painter", "PUT", "/v1/me/avatar", testPng(80, 80)),
  );
  const second = await avatarOf(
    await asAccount(market, "acct_painter", "PUT", "/v1/me/avatar", testPng(96, 96)),
  );
  expect(second).not.toBe(first);

  // Within the grace period an upload on its way may still name it: nothing goes.
  await sweep(Date.now());
  expect(await keys("avatars/")).toEqual(expect.arrayContaining([`avatars/${first}`]));

  // Past it the cron first claims the object and deletes it only on a later run.
  const past = Date.now() + pictureGraceMs + 60_000;
  await sweep(past);
  expect(await keys("avatars/")).toContain(`avatars/${first}`);
  await sweep(past + pictureClaimMs + 60_000);
  const left = await keys("avatars/");
  expect(left).not.toContain(`avatars/${first}`);
  expect(left).toContain(`avatars/${second}`);
  expect((await market.fetch(`/v1/avatars/${second}`)).status).toBe(200);
  // The old one's bytes stopped counting: only the shown avatar is charged.
  const charged = await market.dbs.publishers
    .prepare("SELECT key FROM pictures WHERE publisher = ?1")
    .bind(painter.id)
    .all<{ key: string }>();
  expect(charged.results.map((row) => row.key)).toEqual([`avatars/${second}`]);
});

it("a listing picture for a slot past the next free one is refused before any bytes are stored", async () => {
  await liveVersion(market, "acct_painter", painter, {
    type: "spade-skill",
    name: "painted-skill",
    files: sampleSkill("painted-skill"),
  });
  const before = await keys("previews/");
  const response = await asAccount(
    market,
    "acct_painter",
    "PUT",
    "/v1/me/entries/spade-skill/painted-skill/previews/2",
    testPng(640, 400),
  );
  expect(response.status).toBe(400);
  expect(await keys("previews/")).toEqual(before);
  const charged = await market.dbs.publishers
    .prepare("SELECT COUNT(*) AS n FROM pictures WHERE key LIKE 'previews/%' AND publisher = ?1")
    .bind(painter.id)
    .first<{ n: number }>();
  expect(charged?.n).toBe(0);
});

it("a stored avatar counts against a later archive upload's quota", async () => {
  const tight = await establishedPublisher(market, "acct_tight", "tight");
  const draft = sampleSkill("tight-skill");
  const size = writeArchiveSize(draft);
  // Fill the quota to all but a little under the archive's size, with a charged picture.
  await market.dbs.publishers
    .prepare("INSERT INTO pictures (key, publisher, size, at) VALUES ('avatars/tight', ?1, ?2, 1)")
    .bind(tight.id, 1024 * 1024 * 1024 - Math.floor(size / 2))
    .run();
  const response = await createDraft(market, "acct_tight", {
    type: "spade-skill",
    name: "tight-skill",
    files: draft,
  });
  expect(response.status).toBe(429);
  expect((await jsonOf<{ error: string }>(response)).error).toBe("quota");
});

const reserve = (publisher: string, key: string, now: number) =>
  reservePicture(market.dbs.publishers, {
    publisher,
    key,
    size: 100,
    quotaBytes: 1024 * 1024 * 1024,
    now,
  });
const tombstone = (key: string) =>
  market.dbs.publishers
    .prepare("SELECT key FROM picture_tombstones WHERE key = ?1")
    .bind(key)
    .first();

it("an orphaned avatar the cron has claimed is kept when an upload charges that key again before the delete", async () => {
  const racer = await establishedPublisher(market, "acct_racer", "racer");
  const old = await avatarOf(
    await asAccount(market, "acct_racer", "PUT", "/v1/me/avatar", testPng(112, 112)),
  );
  await asAccount(market, "acct_racer", "PUT", "/v1/me/avatar", testPng(128, 128));
  const key = `avatars/${old}`;

  // The old avatar's row is dropped and its object claimed, not yet deleted.
  const past = Date.now() + pictureGraceMs + 60_000;
  await sweep(past);
  expect(await keys("avatars/")).toContain(key);

  // An upload of those very bytes charges the key (its bytes are already there) before the
  // cron's next run.
  expect(await reserve(racer.id, key, past + 1_000)).toBe("stored");
  expect(await tombstone(key)).toBeNull();

  await sweep(past + pictureClaimMs + 60_000);
  expect(await keys("avatars/")).toContain(key);
  const row = await market.dbs.publishers
    .prepare("SELECT publisher FROM pictures WHERE key = ?1")
    .bind(key)
    .first<{ publisher: string }>();
  expect(row?.publisher).toBe(racer.id);
});

it("an upload that lands while the cron deletes its object is refused until the delete is done", async () => {
  const late = await establishedPublisher(market, "acct_late", "late");
  const old = await avatarOf(
    await asAccount(market, "acct_late", "PUT", "/v1/me/avatar", testPng(144, 144)),
  );
  await asAccount(market, "acct_late", "PUT", "/v1/me/avatar", testPng(160, 160));
  const key = `avatars/${old}`;
  const past = Date.now() + pictureGraceMs + 60_000;
  await sweep(past);
  expect(await keys("avatars/")).toContain(key);

  // An upload of the same bytes arrives in the moment between the cron's last check and its
  // delete from R2: it must not be charged, or it would name bytes about to vanish.
  const during: string[] = [];
  const objects = new Proxy(market.objects, {
    get(target, name, receiver) {
      if (name !== "delete") return Reflect.get(target, name, receiver);
      return async (deleting: string | string[]) => {
        if ([deleting].flat().includes(key)) during.push(await reserve(late.id, key, past + 2));
        return target.delete(deleting);
      };
    },
  });
  await sweepPictures(
    { dbs: market.dbs, OBJECTS: objects },
    past + pictureClaimMs + 60_000,
    crypto.randomUUID(),
  );
  expect(during).toEqual(["deleting"]);
  expect(await keys("avatars/")).not.toContain(key);
  expect(await tombstone(key)).toBeNull();
  // Once the delete is done, the retried upload is charged.
  expect(await reserve(late.id, key, past + 3)).toBe("stored");
});

/** An orphaned avatar of a new publisher, its row dropped and its object claimed by one run. */
async function claimedOrphan(account: string, handle: string, side: number) {
  const publisher = await establishedPublisher(market, account, handle);
  const old = await avatarOf(
    await asAccount(market, account, "PUT", "/v1/me/avatar", testPng(side, side)),
  );
  await asAccount(market, account, "PUT", "/v1/me/avatar", testPng(side + 8, side + 8));
  const past = Date.now() + pictureGraceMs + 60_000;
  await sweep(past);
  const key = `avatars/${old}`;
  expect(await keys("avatars/")).toContain(key);
  return { publisher, key, due: past + pictureClaimMs + 60_000 };
}

/**
 * A sweep whose run stalls right after it marks `key` deleting: `meanwhile` runs there, then the
 * sweep goes on. Resolves to the keys this sweep asked R2 to delete.
 */
async function stalledSweep(key: string, now: number, meanwhile: () => Promise<void>) {
  const deleted: string[] = [];
  let stalled = false;
  const db = new Proxy(market.dbs.publishers, {
    get(target, name, receiver) {
      if (name !== "batch") return Reflect.get(target, name, receiver);
      return async (statements: D1PreparedStatement[]) => {
        const results = await target.batch(statements);
        const marks = results.some((result) =>
          (result.results as { key?: unknown }[]).some((row) => row.key === key),
        );
        if (marks && !stalled) {
          stalled = true;
          await meanwhile();
        }
        return results;
      };
    },
  });
  const objects = new Proxy(market.objects, {
    get(target, name, receiver) {
      if (name !== "delete") return Reflect.get(target, name, receiver);
      return async (deleting: string | string[]) => {
        deleted.push(...[deleting].flat());
        return target.delete(deleting);
      };
    },
  });
  await sweepPictures(
    { dbs: { ...market.dbs, publishers: db }, OBJECTS: objects },
    now,
    crypto.randomUUID(),
  );
  expect(stalled).toBe(true);
  return deleted;
}

/** A plain sweep that records the keys it asked R2 to delete. */
async function watchedSweep(now: number) {
  const deleted: string[] = [];
  const objects = new Proxy(market.objects, {
    get(target, name, receiver) {
      if (name !== "delete") return Reflect.get(target, name, receiver);
      return async (deleting: string | string[]) => {
        deleted.push(...[deleting].flat());
        return target.delete(deleting);
      };
    },
  });
  await sweepPictures({ dbs: market.dbs, OBJECTS: objects }, now, crypto.randomUUID());
  return deleted;
}

it("a second sweep that runs while another holds a claim leaves that object to the holder", async () => {
  const { key, due } = await claimedOrphan("acct_twin", "twin", 176);
  let second: string[] = [];
  const first = await stalledSweep(key, due, async () => {
    second = await watchedSweep(due + 1_000);
  });
  expect(second).not.toContain(key);
  expect(first).toContain(key);
  expect(await keys("avatars/")).not.toContain(key);
  expect(await tombstone(key)).toBeNull();
});

it("a stalled sweep whose claim a later sweep took over deletes nothing when it resumes", async () => {
  const { key, due } = await claimedOrphan("acct_stall", "stall", 192);
  let later: string[] = [];
  const stale = await stalledSweep(key, due, async () => {
    later = await watchedSweep(due + pictureLeaseMs + 60_000);
  });
  expect(later).toContain(key);
  expect(stale).toEqual([]);
  expect(await keys("avatars/")).not.toContain(key);
  expect(await tombstone(key)).toBeNull();
});

it("bytes uploaded again after a later sweep took over and finished survive the stalled sweep", async () => {
  const { publisher, key, due } = await claimedOrphan("acct_again", "again", 208);
  const stale = await stalledSweep(key, due, async () => {
    expect(await watchedSweep(due + pictureLeaseMs + 60_000)).toContain(key);
    // The claim is gone, so an upload of the same key is charged and writes its bytes.
    expect(await reserve(publisher.id, key, due + pictureLeaseMs + 61_000)).toBe("stored");
    await market.objects.put(key, testPng(208, 208));
  });
  expect(stale).toEqual([]);
  expect(await keys("avatars/")).toContain(key);
});

it("an object a sweep died holding is collected by a later sweep once its lease lapses", async () => {
  const { key, due } = await claimedOrphan("acct_dead", "dead", 224);
  // The holder marks the key deleting and never gets further.
  const holder = new Proxy(market.objects, {
    get(target, name, receiver) {
      if (name !== "delete") return Reflect.get(target, name, receiver);
      return async () => {
        throw new Error("the run died");
      };
    },
  });
  await expect(
    sweepPictures({ dbs: market.dbs, OBJECTS: holder }, due, crypto.randomUUID()),
  ).rejects.toThrow("the run died");
  expect(await keys("avatars/")).toContain(key);
  // Within the lease no other run touches it; past it the next run takes it and deletes it.
  expect(await watchedSweep(due + 1_000)).not.toContain(key);
  expect(await watchedSweep(due + pictureLeaseMs + 60_000)).toContain(key);
  expect(await keys("avatars/")).not.toContain(key);
  expect(await tombstone(key)).toBeNull();
});

/** A live entry of the painter's whose listing named a picture and then dropped it. */
async function droppedPreview(name: string, side: number) {
  await liveVersion(market, "acct_painter", painter, {
    type: "spade-skill",
    name,
    files: sampleSkill(name),
  });
  const path = `/v1/me/entries/spade-skill/${name}`;
  const uploaded = await asAccount(
    market,
    "acct_painter",
    "PUT",
    `${path}/previews/0`,
    testPng(640, side),
  );
  expect(uploaded.status).toBe(200);
  const [sha] = (
    await jsonOf<{ listing: { previews: string[] } }>(
      await asAccount(market, "acct_painter", "GET", path),
    )
  ).listing.previews;
  if (!sha) throw new Error("no picture");
  const edit = (previews: string[]) =>
    asAccount(market, "acct_painter", "PUT", `${path}/listing`, {
      title: name,
      line: "A line.",
      description: "Words.",
      categories: [],
      keywords: [],
      links: [],
      previews,
    });
  expect((await edit([])).status).toBe(200);
  return { sha, key: `previews/${sha}`, edit };
}

it("a listing edit that names a picture while the sweep drops it keeps the picture", async () => {
  const { sha, key, edit } = await droppedPreview("renamed-preview", 400);
  const due = Date.now() + pictureGraceMs + 60_000;
  // The sweep read the row as named by nothing; the edit lands before it drops the row.
  let edited = 0;
  const db = new Proxy(market.dbs.publishers, {
    get(target, name, receiver) {
      if (name !== "batch") return Reflect.get(target, name, receiver);
      return async (statements: D1PreparedStatement[]) => {
        if (edited === 0) edited = (await edit([sha])).status;
        return target.batch(statements);
      };
    },
  });
  await sweepPictures(
    { dbs: { ...market.dbs, publishers: db }, OBJECTS: market.objects },
    due,
    "a",
  );
  expect(edited).toBe(200);
  // Later runs claim and delete only what nothing holds: this picture stays.
  await sweep(due + 1_000);
  await sweep(due + pictureClaimMs + 120_000);
  expect(await keys("previews/")).toContain(key);
  const held = await market.dbs.publishers
    .prepare("SELECT 1 AS found FROM pictures WHERE key = ?1")
    .bind(key)
    .first();
  expect(held).not.toBeNull();
});

it("a listing edit can't name a picture the cron is deleting", async () => {
  const { sha, key, edit } = await droppedPreview("deleting-preview", 408);
  await market.dbs.publishers.batch([
    market.dbs.publishers.prepare("DELETE FROM pictures WHERE key = ?1").bind(key),
    market.dbs.publishers
      .prepare(
        "INSERT INTO picture_tombstones (key, claimed_at, deleting, owner, generation, leased_at) VALUES (?1, 1, 1, 'run', 1, ?2)",
      )
      .bind(key, Date.now()),
  ]);
  expect((await edit([sha])).status).toBe(409);
});
