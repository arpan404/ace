import { afterAll, beforeAll, expect, it } from "vitest";
import { sampleSkill } from "@ace/marketplace/testing";
import { sweepPictures } from "./cron-publishers.ts";
import { pictureGraceMs } from "./store/profiles.ts";
import { startMarket, type Market } from "./testing/harness.ts";
import {
  asAccount,
  establishedPublisher,
  jsonOf,
  liveVersion,
  testPng,
} from "./testing/publisher-harness.ts";

/*
 * Avatars and listing pictures (ADR 0173 §3, §5, §9) against the market's D1 and R2: their bytes
 * count against the publisher's quota, a bad picture slot writes nothing, and the cron collects
 * pictures nothing names once the grace period has passed.
 */

let market: Market;
let painter: { id: string; handle: string };
beforeAll(async () => {
  market = await startMarket();
  painter = await establishedPublisher(market, "acct_painter", "painter");
}, 60_000);
afterAll(() => market.close());

const avatarOf = async (response: Response) => (await jsonOf<{ avatar: string }>(response)).avatar;
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

  await sweep(Date.now() + pictureGraceMs + 60_000);
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
