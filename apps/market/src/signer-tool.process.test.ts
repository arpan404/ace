import { afterAll, beforeAll, expect, it } from "vitest";
import {
  hashFiles,
  manifestMismatch,
  readArchive,
  typeLimits,
  verifyManifest,
  verifyReviewMark,
  verifyWithdrawn,
} from "@ace/marketplace";
import { VersionBody } from "@ace/protocol/marketplace";
import { signPending, signReview, type SignerIo } from "@ace/marketplace/signer";
import { folder, keySetOf, sampleSkill } from "@ace/marketplace/testing";
import {
  asSigner,
  marketGrant,
  marketKey,
  publish,
  startMarket,
  type Market,
} from "./testing/harness.ts";

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
  await signPending(io, marketKey, now, keySetOf(marketKey));
  const withdraw = await market.fetch(
    "/v1/publish/spade-skill/gone-skill/versions/1.0.0/withdraw",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${marketGrant("acct_a")}`,
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
