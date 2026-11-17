import { afterAll, beforeAll, expect, it } from "vitest";
import { sampleSkill } from "@ace/marketplace/testing";
import { sweepPictures } from "./cron-publishers.ts";
import { pictureClaimMs, pictureGraceMs, reservePicture } from "./store/profiles.ts";
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
 * Avatars and listing pictures (ADR 0173 §3, §5, §9) against the market's D1 and R2: their bytes
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
const sweep = (now: number) => sweepPictures({ MARKET: market.db, OBJECTS: market.objects }, now);

it("an avatar that doesn't fit the publisher's quota is refused and stores nothing", async () => {
  const crowded = await establishedPublisher(market, "acct_crowded", "crowded");
  // Pictures already charged to the publisher fill its 1 GiB quota but for a few bytes.
  await market.db
    .prepare("INSERT INTO pictures (key, publisher, size, at) VALUES ('previews/full', ?1, ?2, 1)")
    .bind(crowded.id, 1024 * 1024 * 1024 - 16)
    .run();
  const before = await keys("avatars/");
  const response = await asAccount(market, "acct_crowded", "PUT", "/v1/me/avatar", testPng(64, 64));
  expect(response.status).toBe(429);
  expect(await keys("avatars/")).toEqual(before);
  const row = await market.db
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
  const charged = await market.db
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
  const charged = await market.db
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
  await market.db
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
  reservePicture(market.db, { publisher, key, size: 100, quotaBytes: 1024 * 1024 * 1024, now });
const tombstone = (key: string) =>
  market.db.prepare("SELECT key FROM picture_tombstones WHERE key = ?1").bind(key).first();

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
  const row = await market.db
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
  await sweepPictures({ MARKET: market.db, OBJECTS: objects }, past + pictureClaimMs + 60_000);
  expect(during).toEqual(["deleting"]);
  expect(await keys("avatars/")).not.toContain(key);
  expect(await tombstone(key)).toBeNull();
  // Once the delete is done, the retried upload is charged.
  expect(await reserve(late.id, key, past + 3)).toBe("stored");
});
