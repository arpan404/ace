import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMarket, type Market } from "./testing/harness.ts";
import {
  asAccount,
  grantFor,
  jsonOf,
  makeProfile,
  pngChunk,
  testPng,
} from "./testing/publisher-harness.ts";

/*
 * Publisher profiles and verification through the Worker (ADR 0173 §3, §13): handles, lookalikes,
 * retired handles, links, avatars, the public profile and proof tokens. No check here reaches
 * the network: proof fetches are tested over a fake fetch in verify-proofs.test.ts.
 */

let market: Market;
beforeAll(async () => {
  market = await startMarket();
  await makeProfile(market, "acct_first", "first-handle");
});
afterAll(() => market.close());

const create = (account: string, handle: string, extra: Record<string, unknown> = {}) =>
  asAccount(market, account, "POST", "/v1/me/profile", {
    handle,
    displayName: "Someone",
    ...extra,
  });

describe("handles", () => {
  it.each([
    ["too short", "ab", 400],
    ["with capitals", "Shouty", 400],
    ["with a double dash", "two--dashes", 400],
    ["reserved", "admin", 422],
    ["holding a reserved word", "support-desk", 422],
    ["a lookalike of a taken one", "flrst-handle", 409],
    ["taken", "first-handle", 409],
  ])("a handle %s is refused", async (_label, handle, status) => {
    expect((await create("acct_try", handle)).status).toBe(status);
  });

  it("an account makes one profile; a second is refused", async () => {
    expect((await create("acct_once", "once-only")).status).toBe(201);
    expect((await create("acct_once", "twice-now")).status).toBe(409);
  });

  it("a handle given up is retired for its account: nobody else takes it, its owner can", async () => {
    await makeProfile(market, "acct_mover", "old-name");
    const moved = await asAccount(market, "acct_mover", "PUT", "/v1/me/handle", {
      handle: "new-name",
    });
    expect(moved.status).toBe(200);
    expect((await market.fetch("/v1/publishers/new-name")).status).toBe(200);
    expect((await market.fetch("/v1/publishers/old-name")).status).toBe(404);
    expect((await create("acct_squatter", "old-name")).status).toBe(409);
    const back = await asAccount(market, "acct_mover", "PUT", "/v1/me/handle", {
      handle: "old-name",
    });
    expect(back.status).toBe(200);
  });
});

describe("profile fields", () => {
  it("links are https only, with no IP-literal host", async () => {
    expect(
      (
        await create("acct_links", "link-person", {
          links: [{ label: "Site", url: "http://example.org" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await create("acct_links", "link-person", {
          links: [{ label: "Box", url: "https://10.0.0.1/x" }],
        })
      ).status,
    ).toBe(422);
    const made = await create("acct_links", "link-person", {
      links: [{ label: "Site", url: "https://example.org/me" }],
    });
    expect(made.status).toBe(201);
    const page = await jsonOf<{
      profile: { links: unknown[]; displayName: string; verified: boolean };
    }>(await market.fetch("/v1/publishers/link-person"));
    expect(page.profile).toMatchObject({
      links: [{ label: "Site", url: "https://example.org/me" }],
      displayName: "Someone",
      verified: false,
    });
  });

  it("an avatar is stripped of its metadata and served as its own type", async () => {
    await makeProfile(market, "acct_face", "face-person");
    const marked = testPng(
      256,
      256,
      pngChunk("tEXt", new TextEncoder().encode("Comment\0secret-note")),
    );
    const response = await asAccount(market, "acct_face", "PUT", "/v1/me/avatar", marked);
    expect(response.status).toBe(200);
    const { avatar } = await jsonOf<{ avatar: string }>(response);
    const served = await market.fetch(`/v1/avatars/${avatar}`);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toContain("default-src 'none'");
    const bytes = new TextDecoder("latin1").decode(await served.arrayBuffer());
    expect(bytes).not.toContain("secret-note");
    const page = await jsonOf<{ profile: { avatar: string } }>(
      await market.fetch("/v1/publishers/face-person"),
    );
    expect(page.profile.avatar).toBe(avatar);
  });

  it.each([
    ["not a picture", new TextEncoder().encode("<svg/>")],
    ["too small", testPng(16, 16)],
    ["too wide", testPng(900, 100)],
  ])("an avatar %s is refused", async (_label, bytes) => {
    await makeProfile(market, `acct_bad_${_label.length}`, `bad-face-${_label.length}`);
    const response = await asAccount(
      market,
      `acct_bad_${_label.length}`,
      "PUT",
      "/v1/me/avatar",
      bytes,
    );
    expect(response.status).toBe(422);
  });

  it("a verified publisher's profile edit needs a recent sign-in", async () => {
    await makeProfile(market, "acct_known", "known-person");
    await market.dbs.publishers
      .prepare("UPDATE publishers SET verified = 1 WHERE name = 'known-person'")
      .run();
    const stale = await asAccount(
      market,
      "acct_known",
      "PUT",
      "/v1/me/profile",
      { bio: "Hi" },
      {
        authAt: Date.now() - 20 * 60_000,
      },
    );
    expect(stale.status).toBe(401);
    expect(
      (await asAccount(market, "acct_known", "PUT", "/v1/me/profile", { bio: "Hi" })).status,
    ).toBe(200);
  });

  it("a suspended publisher's profile isn't shown", async () => {
    await makeProfile(market, "acct_gone", "gone-person");
    await market.dbs.publishers
      .prepare("UPDATE publishers SET state = 'suspended' WHERE name = 'gone-person'")
      .run();
    expect((await market.fetch("/v1/publishers/gone-person")).status).toBe(404);
    // Its own page still answers, saying why it can't publish.
    const me = await jsonOf<{ state: string }>(
      await asAccount(market, "acct_gone", "GET", "/v1/me"),
    );
    expect(me.state).toBe("suspended");
  });
});

describe("verification", () => {
  type Status = {
    state: string;
    challenges: {
      kind: string;
      token: string;
      state: string;
      problem?: string;
      expiresAt: number;
    }[];
  };

  it("applying issues one fresh token per claim, valid 48 hours", async () => {
    await makeProfile(market, "acct_proof", "proof-person");
    const applied = await asAccount(market, "acct_proof", "POST", "/v1/me/verification", {
      domain: "example.org",
      github: "octo",
    });
    expect(applied.status).toBe(200);
    const first = await jsonOf<Status>(applied);
    expect(first.challenges.map((row) => [row.kind, row.state])).toEqual([
      ["domain", "waiting"],
      ["github", "waiting"],
    ]);
    const [domain] = first.challenges;
    expect(domain?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((domain?.expiresAt ?? 0) - Date.now()).toBeGreaterThan(47 * 3_600_000);
    const again = await jsonOf<Status>(
      await asAccount(market, "acct_proof", "POST", "/v1/me/verification", {
        domain: "example.org",
      }),
    );
    expect(again.challenges[0]?.token).not.toBe(domain?.token);
  });

  it("an expired token fails its check without fetching, and a spent one isn't checked again", async () => {
    await makeProfile(market, "acct_late", "late-person");
    await asAccount(market, "acct_late", "POST", "/v1/me/verification", { domain: "example.org" });
    const publisher = await market.dbs.publishers
      .prepare("SELECT id FROM publishers WHERE name = 'late-person'")
      .first<{ id: string }>();
    await market.dbs.publishers
      .prepare("UPDATE verification_challenges SET expires = 1 WHERE publisher = ?1")
      .bind(publisher?.id)
      .run();
    const checked = await jsonOf<Status>(
      await asAccount(market, "acct_late", "POST", "/v1/me/verification/check"),
    );
    expect(checked.challenges[0]).toMatchObject({
      state: "failed",
      problem: expect.stringContaining("expired"),
    });
    await market.dbs.publishers
      .prepare(
        "UPDATE verification_challenges SET state = 'passed', problem = NULL WHERE publisher = ?1",
      )
      .bind(publisher?.id)
      .run();
    const spent = await jsonOf<Status>(
      await asAccount(market, "acct_late", "POST", "/v1/me/verification/check"),
    );
    expect(spent.challenges[0]?.state).toBe("passed");
    expect(spent.state).toBe("none");
  });

  it("applying needs a recent sign-in", async () => {
    await makeProfile(market, "acct_slow", "slow-person");
    const response = await market.fetch("/v1/me/verification", {
      method: "POST",
      headers: {
        authorization: `Bearer ${grantFor("acct_slow", { authAt: Date.now() - 60 * 60_000 })}`,
      },
      body: JSON.stringify({ domain: "example.org" }),
    });
    expect(response.status).toBe(401);
  });
});
