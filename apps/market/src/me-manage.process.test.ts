import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleSkill } from "@ace/marketplace/testing";
import { asSigner, startMarket, type Market } from "./testing/harness.ts";
import {
  asAccount,
  draftAndPublish,
  establishedPublisher,
  indexNames,
  jsonOf,
  liveVersion,
  searchNames,
  testPng,
} from "./testing/publisher-harness.ts";

/*
 * A publisher managing their publications (ADR 0173 §5) through the Worker's API: listing edits,
 * pictures, latest and rollback, deprecation, withdrawal, deletion, visibility, archive, pins,
 * transfers, signals and appeals.
 */

let market: Market;
let maker: { id: string; handle: string };
let taker: { id: string; handle: string };

beforeAll(async () => {
  market = await startMarket();
  maker = await establishedPublisher(market, "acct_maker", "manage-maker");
  taker = await establishedPublisher(market, "acct_taker", "manage-taker");
}, 60_000);
afterAll(() => market.close());

const skill = (name: string, version = "1.0.0", extra: Record<string, string> = {}) => ({
  type: "spade-skill" as const,
  name,
  version,
  files: sampleSkill(name, { "v.md": version, ...extra }),
});
const live = (name: string, version?: string) =>
  liveVersion(market, "acct_maker", maker, skill(name, version));
const me = (method: string, path: string, body?: unknown, account = "acct_maker") =>
  asAccount(market, account, method, path, body);
const entryPath = (name: string) => `/v1/me/entries/spade-skill/${name}`;
const page = async (name: string) =>
  jsonOf<{
    entry: { title: string; version?: string; deprecated?: string; publisher: { name: string } };
    links: unknown[];
    previews: string[];
    unlisted: boolean;
  }>(await market.fetch(`/v1/entries/spade-skill/${name}`));

const listing = (title: string) => ({
  title,
  line: "A clearer line.",
  description: "Longer words.",
  categories: [],
  keywords: ["notes"],
  links: [{ label: "Home", url: "https://example.org/notes" }],
  previews: [],
});

describe("listing", () => {
  it("an edit to an entry without the review mark applies at once", async () => {
    await live("edited-skill");
    const response = await me(
      "PUT",
      `${entryPath("edited-skill")}/listing`,
      listing("Better notes"),
    );
    expect(response.status).toBe(200);
    const shown = await page("edited-skill");
    expect(shown.entry.title).toBe("Better notes");
    expect(shown.links).toEqual([{ label: "Home", url: "https://example.org/notes" }]);
  });

  it("an edit to a reviewed entry waits for a maintainer and shows nothing yet", async () => {
    await live("reviewed-skill");
    await market.db.prepare("UPDATE entries SET reviewed = 1 WHERE name = 'reviewed-skill'").run();
    const response = await me("PUT", `${entryPath("reviewed-skill")}/listing`, listing("Changed"));
    expect(response.status).toBe(202);
    expect((await page("reviewed-skill")).entry.title).not.toBe("Changed");
    const own = await jsonOf<{ pendingListing?: { listing: { title: string } } }>(
      await me("GET", entryPath("reviewed-skill")),
    );
    expect(own.pendingListing?.listing.title).toBe("Changed");
  });

  it("a listing picture is stripped, stored, served as an image and shown on the page", async () => {
    await live("pictured-skill");
    const response = await me(
      "PUT",
      `${entryPath("pictured-skill")}/previews/0`,
      testPng(640, 400),
    );
    expect(response.status).toBe(200);
    const [sha] = (await page("pictured-skill")).previews;
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
    const served = await market.fetch(`/v1/previews/${sha}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("cache-control")).toContain("immutable");
    const small = await me("PUT", `${entryPath("pictured-skill")}/previews/1`, testPng(100, 100));
    expect(small.status).toBe(422);
  });
});

describe("versions", () => {
  it("latest picks an earlier live version, the rollback, and null goes back to the newest", async () => {
    await live("rolled-skill", "1.0.0");
    await live("rolled-skill", "1.1.0");
    expect((await page("rolled-skill")).entry.version).toBe("1.1.0");
    expect(
      (await me("PUT", `${entryPath("rolled-skill")}/latest`, { version: "1.0.0" })).status,
    ).toBe(200);
    expect((await page("rolled-skill")).entry.version).toBe("1.0.0");
    const unknown = await me("PUT", `${entryPath("rolled-skill")}/latest`, { version: "9.0.0" });
    expect(unknown.status).toBe(422);
    await me("PUT", `${entryPath("rolled-skill")}/latest`, { version: null });
    expect((await page("rolled-skill")).entry.version).toBe("1.1.0");
  });

  it("deprecating the latest version shows its note on the index; undeprecating clears it", async () => {
    await live("old-skill");
    const path = `${entryPath("old-skill")}/versions/1.0.0/deprecation`;
    expect((await me("PUT", path, { note: "Use new-skill instead." })).status).toBe(200);
    expect((await page("old-skill")).entry.deprecated).toBe("Use new-skill instead.");
    expect((await me("DELETE", path)).status).toBe(200);
    expect((await page("old-skill")).entry.deprecated).toBeUndefined();
  });

  it("a changelog is stored on the version", async () => {
    await live("logged-skill");
    await me("PUT", `${entryPath("logged-skill")}/versions/1.0.0/changelog`, { text: "Fixes." });
    const own = await jsonOf<{ versions: { changelog: string }[] }>(
      await me("GET", entryPath("logged-skill")),
    );
    expect(own.versions[0]?.changelog).toBe("Fixes.");
  });

  it("withdrawing a version or the whole entry waits for the signer", async () => {
    await live("pulled-skill", "1.0.0");
    await live("pulled-skill", "1.1.0");
    const one = await me("POST", `${entryPath("pulled-skill")}/versions/1.0.0/withdraw`, {
      reason: "Broken.",
    });
    expect(one.status).toBe(202);
    const all = await me("POST", `${entryPath("pulled-skill")}/withdraw`, { reason: "Retired." });
    expect(all.status).toBe(202);
    const pending = await jsonOf<{
      withdrawals: { name: string; version: string; reason: string }[];
    }>(await market.fetch("/v1/signer/pending", { headers: asSigner }));
    expect(
      pending.withdrawals
        .filter((row) => row.name === "pulled-skill")
        .map((row) => [row.version, row.reason])
        .toSorted(),
    ).toEqual([
      ["1.0.0", "Retired."],
      ["1.1.0", "Retired."],
    ]);
  });

  it("an entry that never listed can be deleted; a listed one can't", async () => {
    const published = await draftAndPublish(market, "acct_maker", skill("unsigned-skill"));
    expect(published.status).toBe(201);
    expect((await me("DELETE", entryPath("unsigned-skill"))).status).toBe(200);
    expect((await me("GET", entryPath("unsigned-skill"))).status).toBe(404);
    await live("kept-skill");
    expect((await me("DELETE", entryPath("kept-skill"))).status).toBe(409);
  });

  it("an appeal answers a blocked or held version only, naming an uploaded replacement", async () => {
    await live("fine-skill");
    const notHeld = await me("POST", `${entryPath("fine-skill")}/versions/1.0.0/appeal`, {
      note: "Please look.",
    });
    expect(notHeld.status).toBe(409);
    const held = await draftAndPublish(market, "acct_maker", skill("fine-skill", "1.1.0"));
    expect(held.status).toBe(201);
    await market.db
      .prepare("UPDATE versions SET state = 'held' WHERE name = 'fine-skill' AND version = '1.1.0'")
      .run();
    const path = `${entryPath("fine-skill")}/versions/1.1.0/appeal`;
    const missing = await me("POST", path, { note: "Fixed.", replacement: "1.2.0" });
    expect(missing.status).toBe(422);
    const appealed = await me("POST", path, { note: "It only reads its own files." });
    expect(appealed.status).toBe(201);
    expect((await me("POST", path, { note: "Again." })).status).toBe(409);
    const own = await jsonOf<{ versions: { version: string; appeal?: { state: string } }[] }>(
      await me("GET", entryPath("fine-skill")),
    );
    expect(own.versions.find((row) => row.version === "1.1.0")?.appeal?.state).toBe("open");
  });
});

describe("visibility, archive and pins", () => {
  it("an unlisted entry leaves the index and search, while its page and object still answer", async () => {
    await live("quiet-skill");
    expect(await searchNames(market, "quiet")).toContain("spade-skill/quiet-skill");
    await me("PUT", `${entryPath("quiet-skill")}/visibility`, { visibility: "unlisted" });
    expect(await indexNames(market)).not.toContain("spade-skill/quiet-skill");
    expect(await searchNames(market, "quiet")).not.toContain("spade-skill/quiet-skill");
    const shown = await page("quiet-skill");
    expect(shown.unlisted).toBe(true);
    const versions = await jsonOf<{ versions: { hash: string }[] }>(
      await market.fetch("/v1/entries/spade-skill/quiet-skill"),
    );
    expect((await market.fetch(`/v1/objects/${versions.versions[0]?.hash}`)).status).toBe(200);
    await me("PUT", `${entryPath("quiet-skill")}/visibility`, { visibility: "listed" });
    expect(await indexNames(market)).toContain("spade-skill/quiet-skill");
  });

  it("an archived entry leaves the index and the profile", async () => {
    await live("shelved-skill");
    await me("PUT", `${entryPath("shelved-skill")}/archived`, { archived: true });
    expect(await indexNames(market)).not.toContain("spade-skill/shelved-skill");
    const profile = await jsonOf<{ entries: { name: string }[] }>(
      await market.fetch(`/v1/publishers/${maker.handle}`),
    );
    expect(profile.entries.map((row) => row.name)).not.toContain("shelved-skill");
  });

  it("pins take only the publisher's own listed entries, and show first on the profile", async () => {
    await live("pinned-skill");
    const own = await me("PUT", "/v1/me/pins", {
      entries: [{ type: "spade-skill", name: "pinned-skill" }],
    });
    expect(own.status).toBe(200);
    const profile = await jsonOf<{ pinned: { name: string }[] }>(
      await market.fetch(`/v1/publishers/${maker.handle}`),
    );
    expect(profile.pinned.map((row) => row.name)).toEqual(["pinned-skill"]);
    const theirs = await me(
      "PUT",
      "/v1/me/pins",
      { entries: [{ type: "spade-skill", name: "pinned-skill" }] },
      "acct_taker",
    );
    expect(theirs.status).toBe(422);
    const seven = Array.from({ length: 7 }, (_, index) => ({ type: "suit", name: `s-${index}` }));
    expect((await me("PUT", "/v1/me/pins", { entries: seven })).status).toBe(400);
  });
});

describe("transfers", () => {
  const offer = async (name: string) => {
    const response = await me("POST", `${entryPath(name)}/transfer`, { to: taker.handle });
    expect(response.status).toBe(201);
    return (await jsonOf<{ id: string }>(response)).id;
  };

  it("an accepted offer moves the entry to the receiver and unpins it from the giver", async () => {
    await live("moved-skill");
    await me("PUT", "/v1/me/pins", { entries: [{ type: "spade-skill", name: "moved-skill" }] });
    const id = await offer("moved-skill");
    const incoming = await jsonOf<{ transfers: { id: string; direction: string }[] }>(
      await me("GET", "/v1/me", undefined, "acct_taker"),
    );
    expect(incoming.transfers).toContainEqual(
      expect.objectContaining({ id, direction: "incoming" }),
    );
    // Only the receiver accepts.
    expect((await me("POST", `/v1/me/transfers/${id}/accept`)).status).toBe(404);
    expect(
      (await me("POST", `/v1/me/transfers/${id}/accept`, undefined, "acct_taker")).status,
    ).toBe(200);
    expect((await page("moved-skill")).entry.publisher.name).toBe(taker.handle);
    expect((await me("GET", entryPath("moved-skill"))).status).toBe(403);
    const profile = await jsonOf<{ profile: { pins: unknown[] } }>(
      await market.fetch(`/v1/publishers/${maker.handle}`),
    );
    expect(profile.profile.pins).toEqual([]);
  });

  it("a declined offer leaves the entry where it was", async () => {
    await live("stayed-skill");
    const id = await offer("stayed-skill");
    expect(
      (await me("POST", `/v1/me/transfers/${id}/decline`, undefined, "acct_taker")).status,
    ).toBe(200);
    expect((await page("stayed-skill")).entry.publisher.name).toBe(maker.handle);
    expect(
      (await me("POST", `/v1/me/transfers/${id}/accept`, undefined, "acct_taker")).status,
    ).toBe(404);
  });

  it("an expired offer can't be accepted", async () => {
    await live("late-skill");
    const id = await offer("late-skill");
    await market.db.prepare("UPDATE transfers SET expires = 1 WHERE id = ?1").bind(id).run();
    expect(
      (await me("POST", `/v1/me/transfers/${id}/accept`, undefined, "acct_taker")).status,
    ).toBe(404);
    expect((await page("late-skill")).entry.publisher.name).toBe(maker.handle);
  });
});

it("signals total downloads per version per day, with adoption and reports", async () => {
  await live("counted-skill", "1.0.0");
  await live("counted-skill", "1.1.0");
  const today = Math.floor(Date.now() / 86_400_000);
  await market.db.batch([
    market.db
      .prepare(
        "INSERT INTO downloads_daily (type, name, version, day, count) VALUES ('spade-skill', 'counted-skill', '1.0.0', ?1, 4)",
      )
      .bind(today - 1),
    market.db
      .prepare(
        "INSERT INTO downloads_daily (type, name, version, day, count) VALUES ('spade-skill', 'counted-skill', '1.1.0', ?1, 12)",
      )
      .bind(today),
    market.db.prepare(
      "INSERT INTO reports (id, type, name, reason, at, state) VALUES ('rpt_0123456789ab', 'spade-skill', 'counted-skill', 'spam', 5, 'dismissed')",
    ),
  ]);
  const body = await jsonOf<{
    days: number[];
    versions: { version: string; downloads: number[] }[];
    adoption: { latest: string; share: number; downloads: number };
    reports: { reason: string; state: string }[];
  }>(await me("GET", `${entryPath("counted-skill")}/signals`));
  expect(body.days).toHaveLength(90);
  expect(body.days.at(-1)).toBe(today);
  const totals = Object.fromEntries(
    body.versions.map((row) => [row.version, row.downloads.reduce((sum, n) => sum + n, 0)]),
  );
  expect(totals).toEqual({ "1.0.0": 4, "1.1.0": 12 });
  expect(body.adoption).toEqual({ latest: "1.1.0", share: 0.75, downloads: 16 });
  expect(body.reports).toEqual([{ reason: "spam", state: "dismissed", at: 5 }]);
});
