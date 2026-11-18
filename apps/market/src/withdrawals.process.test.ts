import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyWithdrawn } from "@ace/marketplace";
import { signPending, signRevocation, type SignerIo } from "@ace/marketplace/signer";
import { keySetOf, sampleRecipe, sampleSkill, signedWithdrawn } from "@ace/marketplace/testing";
import {
  approveHeld,
  asSigner,
  marketKey,
  publish,
  put,
  startMarket,
  type Market,
  personMarketGrant,
} from "./testing/harness.ts";

/*
 * Withdrawals on the real Worker (ADR 0168 §6, §7): a publisher withdraws their own version and
 * nothing else; revoking bytes everywhere is a maintainer's separate act; the signed list and
 * the versions it marks change together, and a retry carries on where an upload stopped.
 */

let market: Market;
beforeAll(async () => {
  market = await startMarket();
});
afterAll(() => market.close());

const io = (): SignerIo => ({
  get: async (path) => (await market.fetch(path, { headers: asSigner })).json(),
  object: async (hash) =>
    new Uint8Array(
      await (await market.fetch(`/v1/signer/objects/${hash}`, { headers: asSigner })).arrayBuffer(),
    ),
  put: async (path, body) => {
    const response = await put(market, path, body);
    return { status: response.status, text: await response.text() };
  },
});
const trusted = keySetOf(marketKey);
let clock = 1_900_000_000_000;
const now = () => (clock += 1000);
type Versions = { versions: { version: string; withdrawn?: string }[] };
const versions = async (name: string, type = "spade-skill") =>
  ((await (await market.fetch(`/v1/entries/${type}/${name}`)).json()) as Versions).versions;
const listed = async () =>
  ((await (await market.fetch("/v1/index")).json()) as { entries: { name: string }[] }).entries.map(
    (e) => e.name,
  );

/** A recipe's files don't name its entry, so another publisher can upload the same bytes. */
const recipeFiles = () => sampleRecipe({ skills: [], plugins: [], needs: { connectors: [] } });

describe("withdrawals", () => {
  it("of a copied archive withdraw the copy only, never the original with the same bytes", async () => {
    expect(
      (await publish(market, { type: "spade-bot", name: "same-bytes", files: recipeFiles() }))
        .status,
    ).toBe(201);
    const copied = await publish(market, {
      type: "spade-bot",
      name: "same-bytes-copy",
      files: recipeFiles(),
      account: "acct_copier",
      publisher: "copier",
    });
    expect(copied.status).toBe(201);
    // Each new publisher's first version is held for a maintainer (ADR 0174 §9).
    await approveHeld(market, "spade-bot", "same-bytes");
    await approveHeld(market, "spade-bot", "same-bytes-copy");
    await signPending(io(), marketKey, now, trusted);
    const withdraw = await market.fetch(
      "/v1/publish/spade-bot/same-bytes-copy/versions/1.0.0/withdraw",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${personMarketGrant(
            "acct_copier",
            "POST /v1/publish/spade-bot/same-bytes-copy/versions/1.0.0/withdraw",
          )}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "Not mine to share" }),
      },
    );
    expect(withdraw.status).toBe(202);
    await signPending(io(), marketKey, now, trusted);
    expect(await versions("same-bytes", "spade-bot")).toEqual([
      expect.not.objectContaining({ withdrawn: expect.anything() }),
    ]);
    expect(await versions("same-bytes-copy", "spade-bot")).toEqual([
      expect.objectContaining({ withdrawn: "Not mine to share" }),
    ]);
    const list = verifyWithdrawn(await (await market.fetch("/v1/withdrawn")).json(), trusted);
    expect(list.withdrawn).toEqual([
      expect.objectContaining({
        scope: "version",
        type: "spade-bot",
        name: "same-bytes-copy",
        version: "1.0.0",
      }),
    ]);
    expect(await listed()).toContain("same-bytes");
  });

  it("revoke bytes everywhere only when a maintainer says so", async () => {
    await publish(market, {
      type: "spade-skill",
      name: "revoked-skill",
      files: sampleSkill("revoked-skill"),
    });
    await signPending(io(), marketKey, now, trusted);
    const hash =
      (
        (await (await market.fetch("/v1/entries/spade-skill/revoked-skill")).json()) as {
          versions: { hash: string }[];
        }
      ).versions[0]?.hash ?? "";
    const answer = await signRevocation(io(), marketKey, now, trusted, { hash, reason: "Malware" });
    expect(answer.status).toBe(200);
    expect(await versions("revoked-skill")).toEqual([
      expect.objectContaining({ withdrawn: "Malware" }),
    ]);
    const list = verifyWithdrawn(await (await market.fetch("/v1/withdrawn")).json(), trusted);
    expect(list.withdrawn).toContainEqual(
      expect.objectContaining({ scope: "hash", hash, reason: "Malware" }),
    );
    expect(await listed()).not.toContain("revoked-skill");
  });

  it("carry on when the same list is sent again, and an older list never undoes a newer one", async () => {
    const stored = await (await market.fetch("/v1/withdrawn")).json();
    expect((await put(market, "/v1/signer/withdrawn", { withdrawn: stored })).status).toBe(200);
    const older = signedWithdrawn([], { key: marketKey, issued: 1 });
    expect((await put(market, "/v1/signer/withdrawn", { withdrawn: older })).status).toBe(409);
    expect(await versions("same-bytes-copy", "spade-bot")).toEqual([
      expect.objectContaining({ withdrawn: "Not mine to share" }),
    ]);
  });
});
