import { afterAll, beforeAll, expect, it } from "vitest";
import {
  hashFiles,
  manifestMismatch,
  readArchive,
  typeLimits,
  verifyManifest,
  verifyOfficialList,
  verifyReviewMark,
  verifyWithdrawn,
} from "@ace/marketplace";
import { VersionBody } from "@ace/protocol/marketplace";
import {
  signOfficialChange,
  signPending,
  signRevocation,
  signReview,
  type SignerIo,
} from "@ace/marketplace/signer";
import { folder, keySetOf, sampleSkill } from "@ace/marketplace/testing";
import {
  asSigner,
  marketKey,
  publish,
  startMarket,
  type Market,
  personMarketGrant,
} from "./testing/harness.ts";
import { approve } from "./testing/discover-harness.ts";

/*
 * `ace market sign`'s core against the real Worker: what it signs is listed and verifies on a
 * device with the shipped keys; what fails the checks again stays unlisted.
 */

let market: Market;
beforeAll(async () => {
  market = await startMarket();
});
afterAll(() => market.close());

const io: SignerIo = {
  get: async (path) => (await market.fetch(path, { headers: asSigner })).json(),
  object: async (hash) =>
    new Uint8Array(
      await (await market.fetch(`/v1/signer/objects/${hash}`, { headers: asSigner })).arrayBuffer(),
    ),
  put: async (path, body) => {
    const response = await market.fetch(path, {
      method: "PUT",
      headers: { ...asSigner, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  },
};
let clock = 1_800_000_000_000;
const now = () => ++clock;

it("signs what passed, lists it, and a device verifies the bytes it fetches", async () => {
  expect(
    (
      await publish(market, {
        type: "spade-skill",
        name: "signed-skill",
        files: sampleSkill("signed-skill"),
      })
    ).status,
  ).toBe(201);
  // A new publisher's first version is held for a maintainer (ADR 0174 §9).
  await approve(market, { type: "spade-skill", name: "signed-skill", files: [] });
  const report = await signPending(io, marketKey, now, keySetOf(marketKey));
  expect(report.signed).toContain("spade-skill/signed-skill@1.0.0");
  const body = VersionBody.parse(
    await (await market.fetch("/v1/entries/spade-skill/signed-skill/1.0.0")).json(),
  );
  const manifest = verifyManifest(body.manifest, keySetOf(marketKey));
  const archive = new Uint8Array(
    await (await market.fetch(`/v1/objects/${manifest.hash}`)).arrayBuffer(),
  );
  expect(
    manifestMismatch(manifest, hashFiles(readArchive(archive, typeLimits["spade-skill"]))),
  ).toBeUndefined();

  expect(
    (
      await signReview(io, marketKey, now, keySetOf(marketKey), {
        type: "spade-skill",
        name: "signed-skill",
        version: "1.0.0",
        reviewed: true,
        byAce: true,
      })
    ).status,
  ).toBe(200);
  const reviewed = VersionBody.parse(
    await (await market.fetch("/v1/entries/spade-skill/signed-skill/1.0.0")).json(),
  );
  expect(verifyReviewMark(reviewed.review, keySetOf(marketKey))).toMatchObject({
    reviewed: true,
    byAce: true,
    hash: manifest.hash,
  });
});

it("signs a publisher's withdrawal into the withdrawn list", async () => {
  await publish(market, {
    type: "spade-skill",
    name: "gone-skill",
    files: sampleSkill("gone-skill"),
  });
  await approve(market, { type: "spade-skill", name: "gone-skill", files: [] });
  await signPending(io, marketKey, now, keySetOf(marketKey));
  const withdraw = await market.fetch(
    "/v1/publish/spade-skill/gone-skill/versions/1.0.0/withdraw",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${personMarketGrant(
          "acct_a",
          "POST /v1/publish/spade-skill/gone-skill/versions/1.0.0/withdraw",
        )}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "Sends mail without asking" }),
    },
  );
  expect(withdraw.status).toBe(202);
  const report = await signPending(io, marketKey, now, keySetOf(marketKey));
  expect(report.withdrawn).toBe(1);
  const list = verifyWithdrawn(
    await (await market.fetch("/v1/withdrawn")).json(),
    keySetOf(marketKey),
  );
  expect(list.withdrawn.map((entry) => entry.reason)).toContain("Sends mail without asking");
});

it("leaves a version unlisted when it fails the checks again", async () => {
  // The bytes the signer is handed don't pass: it refuses them rather than trust the Worker.
  const files = folder({ "SKILL.md": "---\nname: tight-skill\ndescription: Fine.\n---\n" });
  await publish(market, { type: "spade-skill", name: "tight-skill", files });
  const tampered: SignerIo = { ...io, object: async () => new Uint8Array(1024) };
  const report = await signPending(tampered, marketKey, now, keySetOf(marketKey));
  expect(report.refused.map((entry) => entry.version)).toContain("spade-skill/tight-skill@1.0.0");
  expect((await market.fetch("/v1/entries/spade-skill/tight-skill/1.0.0")).status).toBe(404);
});

it("two maintainers editing a list at once: the later edit is refused, never undoing the other", async () => {
  const trusted = keySetOf(marketKey);
  const official = (change: { account: string; add: boolean }, through = io) =>
    signOfficialChange(through, marketKey, now, trusted, change, () => "pub_ace_made_here_000000");
  expect((await official({ account: "acct_first", add: true })).status).toBe(200);
  // The second maintainer reads the lists, then the first takes an account off.
  const read = await io.get("/v1/signer/pending");
  const stale: SignerIo = {
    ...io,
    get: async (path) => (path === "/v1/signer/pending" ? read : io.get(path)),
  };
  expect((await official({ account: "acct_first", add: false })).status).toBe(200);
  const refused = await official({ account: "acct_second", add: true }, stale);
  expect(refused.status).toBe(409);
  expect(refused.text).toContain("run the command again");
  const accounts = async () =>
    verifyOfficialList(await (await market.fetch("/v1/official")).json(), trusted).accounts;
  expect(await accounts()).toEqual([]);
  // Run again, it starts from the stored list and keeps the first maintainer's change.
  expect((await official({ account: "acct_second", add: true })).status).toBe(200);
  expect(await accounts()).toEqual(["acct_second"]);

  // The withdrawn list the same way: a revocation from a stale read never drops a newer one.
  expect(
    (await signRevocation(io, marketKey, now, trusted, { hash: "e".repeat(64), reason: "One" }))
      .status,
  ).toBe(200);
  const readAgain = await io.get("/v1/signer/pending");
  const staleAgain: SignerIo = {
    ...io,
    get: async (path) => (path === "/v1/signer/pending" ? readAgain : io.get(path)),
  };
  expect(
    (await signRevocation(io, marketKey, now, trusted, { hash: "f".repeat(64), reason: "Two" }))
      .status,
  ).toBe(200);
  expect(
    (
      await signRevocation(staleAgain, marketKey, now, trusted, {
        hash: "0".repeat(64),
        reason: "Three",
      })
    ).status,
  ).toBe(409);
  const withdrawn = verifyWithdrawn(await (await market.fetch("/v1/withdrawn")).json(), trusted);
  expect(withdrawn.withdrawn.map((item) => item.reason)).toContain("Two");
  expect(withdrawn.withdrawn.map((item) => item.reason)).not.toContain("Three");
});
