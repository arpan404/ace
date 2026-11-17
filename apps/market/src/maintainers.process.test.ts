import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyBlocklist, verifyOfficialList } from "@ace/marketplace";
import { keySetOf, sampleSkill, testKey } from "@ace/marketplace/testing";
import {
  MarketQueueBody,
  MarketReportsBody,
  SignerPending,
  type MarketScanReport,
} from "@ace/protocol/marketplace";
import {
  asSigner,
  manifestFor,
  marketKey,
  publish,
  put,
  startMarket,
  type Market,
} from "./testing/harness.ts";
import {
  approve,
  blocklistBy,
  everyRow,
  officialBy,
  publishLive,
  verifiedBy,
} from "./testing/discover-harness.ts";
import { listVersion, versionForSigning } from "./store/signer.ts";

/*
 * The maintainers' routes (ADR 0173 §7, §9, §10, §13, §14) through the Worker: the signer's token
 * on every one, holds, blocks and approvals as the signer sees them, listing edits, anonymous
 * reports and the signed lists.
 */

let market: Market;
beforeAll(async () => {
  market = await startMarket();
});
afterAll(() => market.close());

const pending = async () =>
  SignerPending.parse(
    await (await market.fetch("/v1/signer/pending", { headers: asSigner })).json(),
  );
const queue = async () =>
  MarketQueueBody.parse(
    await (await market.fetch("/v1/signer/queue", { headers: asSigner })).json(),
  );
const waiting = async (name: string) =>
  (await pending()).versions.filter((version) => version.name === name);

describe("the signer's token", () => {
  const routes: [string, string][] = [
    ["GET", "/v1/signer/queue"],
    ["GET", "/v1/signer/scan-context"],
    ["PUT", "/v1/signer/holds/spade-skill/x-skill/1.0.0"],
    ["PUT", "/v1/signer/blocks/spade-skill/x-skill/1.0.0"],
    ["PUT", "/v1/signer/listings/spade-skill/x-skill"],
    ["PUT", "/v1/signer/publishers/tester"],
    ["GET", "/v1/signer/publishers/tester"],
    ["PUT", "/v1/signer/collections"],
    ["PUT", "/v1/signer/blocklist"],
    ["PUT", "/v1/signer/verified"],
    ["PUT", "/v1/signer/official"],
    ["GET", "/v1/signer/reports"],
    ["PUT", "/v1/signer/reports/rpt_0123456789abcdef"],
    ["PUT", "/v1/signer/appeals/apl_0123456789abcdef"],
    ["GET", "/v1/signer/pending"],
  ];
  it.each(routes)("%s %s refuses without it or with another", async (method, path) => {
    for (const headers of [{}, { authorization: "Bearer not-the-token" }]) {
      const answer = await market.fetch(path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(method === "PUT" ? { body: "{}" } : {}),
      });
      expect(answer.status).toBe(401);
    }
  });
});

it("a held version waits for a maintainer, not the signer; approving, holding and blocking move it", async () => {
  const upload = {
    type: "spade-skill" as const,
    name: "held-skill",
    files: sampleSkill("held-skill"),
  };
  // A new publisher's first version is held (ADR 0173 §9).
  expect((await publish(market, upload)).status).toBe(201);
  expect(await waiting("held-skill")).toEqual([]);
  expect((await queue()).held.map((item) => item.name)).toContain("held-skill");
  const signed = await put(market, "/v1/signer/versions/spade-skill/held-skill/1.0.0", {
    manifest: manifestFor(upload),
  });
  expect(signed.status).toBe(409);

  await approve(market, upload);
  expect(await waiting("held-skill")).toEqual([expect.objectContaining({ approved: true })]);
  expect((await queue()).held.map((item) => item.name)).not.toContain("held-skill");

  const held = await put(market, "/v1/signer/holds/spade-skill/held-skill/1.0.0", {
    decision: "hold",
  });
  expect(held.status).toBe(200);
  expect(await waiting("held-skill")).toEqual([]);

  const blocked = await put(market, "/v1/signer/blocks/spade-skill/held-skill/1.0.0", {
    reason: "Sends the person's keys away",
  });
  expect(blocked.status).toBe(200);
  expect(await waiting("held-skill")).toEqual([]);
  expect((await queue()).held.map((item) => item.name)).not.toContain("held-skill");
  const row = await market.db
    .prepare("SELECT state, block_reason FROM versions WHERE name = 'held-skill'")
    .first();
  expect(row).toEqual({ state: "blocked", block_reason: "Sends the person's keys away" });
  // A missing version is no one's to decide.
  expect(
    (await put(market, "/v1/signer/holds/spade-skill/nothing-here/1.0.0", { decision: "approve" }))
      .status,
  ).toBe(404);
});

it("a signature racing a maintainer's hold or block never lists the version", async () => {
  for (const [name, decide] of [
    ["raced-block", { route: "blocks", body: { reason: "Sends keys away" } }],
    ["raced-hold", { route: "holds", body: { decision: "hold" } }],
  ] as const) {
    const upload = { type: "spade-skill" as const, name, files: sampleSkill(name) };
    expect((await publish(market, upload)).status).toBe(201);
    await approve(market, upload);
    // The route read the version pending; a maintainer decides before its batch runs.
    const answer = await put(
      market,
      `/v1/signer/${decide.route}/spade-skill/${name}/1.0.0`,
      decide.body,
    );
    expect(answer.status).toBe(200);
    const live = async () =>
      market.db
        .prepare(
          `SELECT v.state, v.listed, p.live_versions FROM versions v
            JOIN entries e ON e.type = v.type AND e.name = v.name
            JOIN publishers p ON p.id = e.publisher WHERE v.name = ?1`,
        )
        .bind(name)
        .first();
    const before = await live();
    const key = { type: "spade-skill", name, version: "1.0.0" };
    const read = await versionForSigning(market.db, key);
    if (!read) throw new Error("no version");
    const checked = {
      manifest: "{}",
      hash: read.hash,
      size: read.size,
      publisher: read.publisher.id,
    };
    expect(await listVersion(market.db, key, checked, Date.now())).toBe(false);
    expect(await live()).toEqual(before);
    expect(before).toMatchObject({ listed: 0 });
    // And through the route, a signature for it is refused.
    const signed = await put(market, `/v1/signer/versions/spade-skill/${name}/1.0.0`, {
      manifest: manifestFor(upload),
    });
    expect(signed.status).toBe(409);
  }
});

it("a hold from the signer's own re-scan shows that scan in the queue", async () => {
  const upload = {
    type: "spade-skill" as const,
    name: "rescan-held",
    files: sampleSkill("rescan-held"),
  };
  expect((await publish(market, upload)).status).toBe(201);
  await approve(market, upload);
  const scan: MarketScanReport = {
    format: "ace-market-scan",
    runnable: false,
    scanner: 1,
    verdict: "warn",
    checks: [],
    findings: [
      {
        check: "scripts",
        rule: "env-read",
        level: "warn",
        path: "scripts/setup.sh",
        line: 2,
        message: "Reads the .env file when it sets up.",
      },
    ],
    truncated: false,
    read: { files: 2, textBytes: 120 },
  };
  const held = await put(market, "/v1/signer/holds/spade-skill/rescan-held/1.0.0", {
    decision: "hold",
    scan,
  });
  expect(held.status).toBe(200);
  const item = (await queue()).held.find((entry) => entry.name === "rescan-held");
  expect(item?.scan).toEqual(scan);
});

it("a pending listing edit is shown once approved and dropped once refused", async () => {
  await publishLive(market, {
    type: "spade-skill",
    name: "edited-skill",
    files: sampleSkill("edited-skill"),
    reviewed: true,
  });
  const edit = (title: string) =>
    market.db
      .prepare("UPDATE entries SET pending_listing = ?1 WHERE name = 'edited-skill'")
      .bind(
        JSON.stringify({
          listing: {
            title,
            line: "Sorts mail",
            description: "",
            categories: [],
            keywords: [],
            links: [],
            previews: [],
          },
          scan: {
            format: "ace-market-scan",
            runnable: false,
            scanner: 1,
            verdict: "pass",
            checks: [],
            findings: [],
            truncated: false,
            read: { files: 0, textBytes: 0 },
          },
          at: 1,
        }),
      )
      .run();
  const title = async () =>
    (
      (await (await market.fetch("/v1/entries/spade-skill/edited-skill")).json()) as {
        entry: { title: string };
      }
    ).entry.title;

  await edit("Mail sorter");
  expect((await queue()).listings.map((item) => item.listing.title)).toEqual(["Mail sorter"]);
  const approved = await put(market, "/v1/signer/listings/spade-skill/edited-skill", {
    decision: "approve",
  });
  expect(approved.status).toBe(200);
  expect(await title()).toBe("Mail sorter");
  expect((await queue()).listings).toEqual([]);

  await edit("Something else");
  await put(market, "/v1/signer/listings/spade-skill/edited-skill", {
    decision: "refuse",
    reason: "Not what it does",
  });
  expect(await title()).toBe("Mail sorter");
  expect((await queue()).listings).toEqual([]);
});

it("takes anonymous reports, limits them per caller, keeps no address, and maintainers resolve them", async () => {
  await publishLive(market, {
    type: "spade-skill",
    name: "reported-skill",
    files: sampleSkill("reported-skill"),
  });
  const address = "203.0.113.200";
  const report = (body: unknown) =>
    market.fetch("/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": address },
      body: JSON.stringify(body),
    });
  const sent = { type: "spade-skill", name: "reported-skill", reason: "spam", note: "Ads only" };
  expect((await report(sent)).status).toBe(202);
  expect((await report({ ...sent, reason: "nonsense" })).status).toBe(400);
  expect((await report({ ...sent, name: "no-such-entry" })).status).toBe(404);
  // The REPORTS binding allows 5 a minute per caller.
  const statuses = [];
  for (let attempt = 0; attempt < 4; attempt++) statuses.push((await report(sent)).status);
  expect(statuses.at(-1)).toBe(429);
  expect(await everyRow(market)).not.toContain(address);

  const listed = MarketReportsBody.parse(
    await (await market.fetch("/v1/signer/reports", { headers: asSigner })).json(),
  ).reports.filter((item) => item.name === "reported-skill");
  expect(listed.length).toBeGreaterThanOrEqual(1);
  expect(listed[0]).toMatchObject({ reason: "spam", note: "Ads only", state: "open" });
  const id = listed[0]?.id ?? "";
  expect(
    (await put(market, `/v1/signer/reports/${id}`, { state: "dismissed", note: "Fine" })).status,
  ).toBe(200);
  const after = MarketReportsBody.parse(
    await (await market.fetch("/v1/signer/reports", { headers: asSigner })).json(),
  ).reports.find((item) => item.id === id);
  expect(after).toMatchObject({ state: "dismissed", outcome: "Fine" });
});

describe("the signed lists", () => {
  it("stores and serves the blocklist, refusing an unknown key and an older list", async () => {
    const list = blocklistBy({
      issued: 100,
      hashes: [{ hash: "a".repeat(64), reason: "Malware" }],
      files: [],
      patterns: [],
    });
    expect((await put(market, "/v1/signer/blocklist", { blocklist: list })).status).toBe(200);
    const served = verifyBlocklist(
      await (await market.fetch("/v1/blocklist")).json(),
      keySetOf(marketKey),
    );
    expect(served.hashes).toEqual([{ hash: "a".repeat(64), reason: "Malware" }]);
    expect((await pending()).blocklist).toEqual(list);

    const stranger = blocklistBy(
      { issued: 200, hashes: [], files: [], patterns: [] },
      testKey("other", 4),
    );
    expect((await put(market, "/v1/signer/blocklist", { blocklist: stranger })).status).toBe(422);
    const older = blocklistBy({ issued: 50, hashes: [], files: [], patterns: [] });
    expect((await put(market, "/v1/signer/blocklist", { blocklist: older })).status).toBe(409);
  });

  it("marks publishers by the verified list and tells one taken off why", async () => {
    await publishLive(market, {
      type: "spade-skill",
      name: "verified-skill",
      files: sampleSkill("verified-skill"),
      account: "acct_v",
      publisher: "trusty-folk",
    });
    const publisher = await market.db
      .prepare("SELECT id FROM publishers WHERE name = 'trusty-folk'")
      .first<{ id: string }>();
    const id = publisher?.id ?? "";
    const on = verifiedBy({
      issued: 10,
      publishers: [{ id, handle: "trusty-folk", proofs: [{ kind: "account" }], at: 5 }],
    });
    expect((await put(market, "/v1/signer/verified", { verified: on })).status).toBe(200);
    expect(await (await market.fetch("/v1/verified")).json()).toEqual(on);
    const entry = async () =>
      (
        (await (await market.fetch("/v1/entries/spade-skill/verified-skill")).json()) as {
          entry: { verified: boolean };
        }
      ).entry.verified;
    expect(await entry()).toBe(true);

    const off = verifiedBy({ issued: 20, publishers: [] });
    expect(
      (
        await put(market, "/v1/signer/verified", {
          verified: off,
          basedOn: 10,
          revoked: [{ handle: "trusty-folk", reason: "The domain changed hands" }],
        })
      ).status,
    ).toBe(200);
    expect(await entry()).toBe(false);
    expect(
      await market.db
        .prepare("SELECT verified, verification, verification_reason FROM publishers WHERE id = ?1")
        .bind(id)
        .first(),
    ).toEqual({
      verified: 0,
      verification: "revoked",
      verification_reason: "The domain changed hands",
    });

    // A list naming a publisher by another handle is refused.
    const wrong = verifiedBy({
      issued: 30,
      publishers: [{ id, handle: "someone-else", proofs: [{ kind: "account" }], at: 5 }],
    });
    expect((await put(market, "/v1/signer/verified", { verified: wrong })).status).toBe(422);
  });

  it("sending the same verified list again repairs entries an interrupted upload left stale", async () => {
    await publishLive(market, {
      type: "spade-skill",
      name: "repaired-skill",
      files: sampleSkill("repaired-skill"),
      account: "acct_r",
      publisher: "repaired-folk",
    });
    const id =
      (
        await market.db
          .prepare("SELECT id FROM publishers WHERE name = 'repaired-folk'")
          .first<{ id: string }>()
      )?.id ?? "";
    const stored = await (await market.fetch("/v1/verified")).json();
    const issued = (stored as { body: { issued: number } }).body.issued;
    const on = verifiedBy({
      issued: issued + 1,
      publishers: [{ id, handle: "repaired-folk", proofs: [{ kind: "account" }], at: 5 }],
    });
    expect(
      (await put(market, "/v1/signer/verified", { verified: on, basedOn: issued })).status,
    ).toBe(200);
    const off = verifiedBy({ issued: issued + 2, publishers: [] });
    const upload = {
      verified: off,
      basedOn: issued + 1,
      revoked: [{ handle: "repaired-folk", reason: "Lapsed" }],
    };
    expect((await put(market, "/v1/signer/verified", upload)).status).toBe(200);
    // Cut off after the list and the publishers were stored, before the entries were refreshed.
    await market.db.prepare("UPDATE entries SET verified = 1 WHERE name = 'repaired-skill'").run();
    expect((await put(market, "/v1/signer/verified", upload)).status).toBe(200);
    const entry = await market.db
      .prepare("SELECT verified FROM entries WHERE name = 'repaired-skill'")
      .first();
    expect(entry).toEqual({ verified: 0 });
  });

  it("refuses a list edit based on a list that is no longer the stored one", async () => {
    const issued = (
      (await (await market.fetch("/v1/blocklist")).json()) as { body: { issued: number } }
    ).body.issued;
    const fresh = blocklistBy({ issued: issued + 10, hashes: [], files: [], patterns: [] });
    // Based on an older list: another maintainer's edit landed in between.
    const stale = await put(market, "/v1/signer/blocklist", {
      blocklist: fresh,
      basedOn: issued - 1,
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("run the command again");
    // Based on nothing while a list is stored.
    expect((await put(market, "/v1/signer/blocklist", { blocklist: fresh })).status).toBe(409);
    expect(
      (await put(market, "/v1/signer/blocklist", { blocklist: fresh, basedOn: issued })).status,
    ).toBe(200);
  });

  it("copies the official list's accounts into official_accounts and serves the list", async () => {
    const list = officialBy({
      issued: 10,
      publisher: { id: "pub_ace0000000000000000000", name: "ace" },
      accounts: ["acct_ace_one", "acct_ace_two"],
    });
    expect((await put(market, "/v1/signer/official", { official: list })).status).toBe(200);
    const rows = await market.db
      .prepare("SELECT account, publisher FROM official_accounts ORDER BY account")
      .all();
    expect(rows.results).toEqual([
      { account: "acct_ace_one", publisher: "pub_ace0000000000000000000" },
      { account: "acct_ace_two", publisher: "pub_ace0000000000000000000" },
    ]);
    expect(
      verifyOfficialList(await (await market.fetch("/v1/official")).json(), keySetOf(marketKey))
        .accounts,
    ).toEqual(["acct_ace_one", "acct_ace_two"]);

    const fewer = officialBy({
      issued: 20,
      publisher: { id: "pub_ace0000000000000000000", name: "ace" },
      accounts: ["acct_ace_two"],
    });
    await put(market, "/v1/signer/official", { official: fewer, basedOn: 10 });
    expect(
      (await market.db.prepare("SELECT account FROM official_accounts").all()).results,
    ).toEqual([{ account: "acct_ace_two" }]);
    const unsigned = officialBy(
      { issued: 30, publisher: { id: "pub_ace0000000000000000000", name: "ace" }, accounts: [] },
      testKey("other", 4),
    );
    expect((await put(market, "/v1/signer/official", { official: unsigned })).status).toBe(422);
  });
});
