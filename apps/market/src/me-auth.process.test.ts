import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeArchive } from "@ace/marketplace";
import { sampleSkill } from "@ace/marketplace/testing";
import { cloudGrant, relayGrant, startMarket, type Market } from "./testing/harness.ts";
import {
  callerAddress,
  createDraft,
  establishedPublisher,
  grantFor,
  indexNames,
  jsonOf,
  liveVersion,
  makeProfile,
  testPng,
  intentOf,
} from "./testing/publisher-harness.ts";

/*
 * Every write refuses anything but a fresh market grant from the account backend for a verified
 * email and an active publisher (ADR 0174 §2); entry routes refuse another account's entry;
 * sensitive actions refuse an old sign-in.
 */

let market: Market;
let draft = "";
const entry = "/v1/me/entries/spade-skill/guarded-skill";
const version = `${entry}/versions/1.0.0`;

beforeAll(async () => {
  market = await startMarket();
  const owner = await establishedPublisher(market, "acct_owner", "gate-keeper");
  await liveVersion(market, "acct_owner", owner, {
    type: "spade-skill",
    name: "guarded-skill",
    files: sampleSkill("guarded-skill"),
  });
  await makeProfile(market, "acct_intruder", "gate-crasher");
  await makeProfile(market, "acct_suspended", "gate-sleeper");
  await market.dbs.publishers
    .prepare("UPDATE publishers SET state = 'suspended' WHERE name = 'gate-sleeper'")
    .run();
  const created = await createDraft(market, "acct_owner", {
    type: "spade-skill",
    name: "guarded-draft",
    files: sampleSkill("guarded-draft"),
  });
  draft = (await jsonOf<{ id: string }>(created)).id;
}, 60_000);
afterAll(() => market.close());

const listing = {
  title: "Guarded",
  line: "A line",
  description: "",
  categories: [],
  keywords: [],
  links: [],
  previews: [],
};
const archive = () => writeArchive(sampleSkill("guarded-skill", { "x.md": "x" }));

interface Write {
  method: string;
  path: () => string;
  body?: () => unknown;
  sensitive?: boolean;
  /** Acts on the owner's entry, so another account is refused. */
  owned?: boolean;
}

const writes: [string, Write][] = [
  [
    "make a profile",
    {
      method: "POST",
      path: () => "/v1/me/profile",
      body: () => ({ handle: "someone-new", displayName: "New" }),
    },
  ],
  [
    "edit the profile",
    { method: "PUT", path: () => "/v1/me/profile", body: () => ({ bio: "Hi" }) },
  ],
  [
    "change the handle",
    {
      method: "PUT",
      path: () => "/v1/me/handle",
      body: () => ({ handle: "renamed-one" }),
      sensitive: true,
    },
  ],
  ["set the avatar", { method: "PUT", path: () => "/v1/me/avatar", body: () => testPng(128, 128) }],
  ["set pins", { method: "PUT", path: () => "/v1/me/pins", body: () => ({ entries: [] }) }],
  [
    "apply for verification",
    {
      method: "POST",
      path: () => "/v1/me/verification",
      body: () => ({ domain: "example.org" }),
      sensitive: true,
    },
  ],
  [
    "check verification",
    { method: "POST", path: () => "/v1/me/verification/check", sensitive: true },
  ],
  [
    "create a draft",
    {
      method: "POST",
      path: () => "/v1/me/drafts?type=spade-skill&name=new-draft&version=1.0.0",
      body: archive,
    },
  ],
  ["replace a draft", { method: "PUT", path: () => `/v1/me/drafts/${draft}`, body: archive }],
  [
    "patch a draft",
    { method: "PATCH", path: () => `/v1/me/drafts/${draft}`, body: () => ({ changelog: "x" }) },
  ],
  ["delete a draft", { method: "DELETE", path: () => `/v1/me/drafts/${draft}` }],
  ["publish a draft", { method: "POST", path: () => `/v1/me/drafts/${draft}/publish` }],
  ["delete an entry", { method: "DELETE", path: () => entry, sensitive: true, owned: true }],
  [
    "edit a listing",
    { method: "PUT", path: () => `${entry}/listing`, body: () => listing, owned: true },
  ],
  [
    "upload a listing picture",
    {
      method: "PUT",
      path: () => `${entry}/previews/0`,
      body: () => testPng(640, 400),
      owned: true,
    },
  ],
  [
    "pick the latest",
    { method: "PUT", path: () => `${entry}/latest`, body: () => ({ version: null }), owned: true },
  ],
  [
    "set visibility",
    {
      method: "PUT",
      path: () => `${entry}/visibility`,
      body: () => ({ visibility: "unlisted" }),
      owned: true,
    },
  ],
  [
    "archive",
    {
      method: "PUT",
      path: () => `${entry}/archived`,
      body: () => ({ archived: true }),
      owned: true,
    },
  ],
  [
    "withdraw an entry",
    {
      method: "POST",
      path: () => `${entry}/withdraw`,
      body: () => ({ reason: "x" }),
      sensitive: true,
      owned: true,
    },
  ],
  [
    "offer a transfer",
    {
      method: "POST",
      path: () => `${entry}/transfer`,
      body: () => ({ to: "gate-crasher" }),
      sensitive: true,
      owned: true,
    },
  ],
  [
    "set a changelog",
    { method: "PUT", path: () => `${version}/changelog`, body: () => ({ text: "x" }), owned: true },
  ],
  [
    "deprecate",
    {
      method: "PUT",
      path: () => `${version}/deprecation`,
      body: () => ({ note: "x" }),
      owned: true,
    },
  ],
  ["undeprecate", { method: "DELETE", path: () => `${version}/deprecation`, owned: true }],
  [
    "withdraw a version",
    {
      method: "POST",
      path: () => `${version}/withdraw`,
      body: () => ({ reason: "x" }),
      sensitive: true,
      owned: true,
    },
  ],
  [
    "appeal",
    { method: "POST", path: () => `${version}/appeal`, body: () => ({ note: "x" }), owned: true },
  ],
  [
    "accept a transfer",
    { method: "POST", path: () => "/v1/me/transfers/trf_0123456789abcdef/accept", sensitive: true },
  ],
  [
    "decline a transfer",
    {
      method: "POST",
      path: () => "/v1/me/transfers/trf_0123456789abcdef/decline",
      sensitive: true,
    },
  ],
  [
    "publish from the CLI",
    {
      method: "POST",
      path: () => "/v1/publish/spade-skill/guarded-skill/versions?version=2.0.0",
      body: archive,
      owned: true,
    },
  ],
  [
    "withdraw from the CLI",
    {
      method: "POST",
      path: () => "/v1/publish/spade-skill/guarded-skill/versions/1.0.0/withdraw",
      body: () => ({ reason: "x" }),
      sensitive: true,
      owned: true,
    },
  ],
  // Reads behind the grant, refused the same way.
  ["read the entry", { method: "GET", path: () => entry, owned: true }],
  ["read signals", { method: "GET", path: () => `${entry}/signals`, owned: true }],
];

/**
 * Sends `write` once with the grant `token` makes for it: given the request's intent (method,
 * path and the digest of this very body), as a person's grant names it (ADR 0190).
 */
async function send(write: Write, token: (action: string) => string | undefined) {
  const body = write.body?.();
  const grant = token(await intentOf(write.method, write.path(), body));
  const bytes = body instanceof Uint8Array;
  return market.fetch(write.path(), {
    method: write.method,
    headers: {
      "cf-connecting-ip": callerAddress(),
      ...(grant ? { authorization: `Bearer ${grant}` } : {}),
      ...(body === undefined
        ? {}
        : { "content-type": bytes ? "application/octet-stream" : "application/json" }),
    },
    ...(body === undefined ? {} : { body: bytes ? body : JSON.stringify(body) }),
  } as Parameters<Market["fetch"]>[1]);
}

const now = Date.now();
const refusals: [string, (action: string) => string | undefined, number, string][] = [
  ["no grant", () => undefined, 401, "unauthorized"],
  [
    "an expired grant",
    (action) => grantFor("acct_owner", { iat: now - 10 * 60_000, action }),
    401,
    "unauthorized",
  ],
  ["a relay grant (the wrong audience)", () => relayGrant("acct_owner"), 401, "unauthorized"],
  ["a cloud grant (the wrong purpose)", () => cloudGrant("acct_owner"), 401, "unauthorized"],
  [
    "the wrong issuer",
    (action) => grantFor("acct_owner", { iss: "cloud.evil.dev", action }),
    401,
    "unauthorized",
  ],
  [
    "an unverified email",
    (action) => grantFor("acct_owner", { emailVerified: false, action }),
    403,
    "email_unverified",
  ],
  ["a suspended account", (action) => grantFor("acct_suspended", { action }), 403, "suspended"],
];

describe.each(writes)("%s", (_label, write) => {
  it.each(refusals)("refuses %s", async (_case, token, status, error) => {
    const response = await send(write, token);
    expect(response.status).toBe(status);
    expect(await jsonOf(response)).toMatchObject({ error, message: expect.any(String) });
  });

  it.runIf(write.owned === true)("refuses another account's entry", async () => {
    const response = await send(write, (action) => grantFor("acct_intruder", { action }));
    expect(response.status).toBe(403);
    expect((await jsonOf(response)).error).toBe("forbidden");
  });

  it.runIf(write.sensitive === true)("refuses a sign-in older than ten minutes", async () => {
    const response = await send(write, (action) =>
      grantFor("acct_owner", { authAt: Date.now() - 11 * 60_000, action }),
    );
    expect(response.status).toBe(401);
    expect((await jsonOf(response)).error).toBe("reauth");
  });

  // ADR 0190: only the person's own grant for this very request, payload and all, does a
  // sensitive action, and only once.
  it.runIf(write.sensitive === true).each<[string, (action: string) => string]>([
    ["a machine's grant", () => grantFor("acct_owner")],
    [
      "a machine's grant naming the request",
      (action) => grantFor("acct_owner", { action, kind: "machine" }),
    ],
    [
      "the person's grant for another payload",
      (action) => grantFor("acct_owner", { action: `${action.slice(0, -4)}AAAA` }),
    ],
    [
      "the person's grant for another request",
      () => grantFor("acct_owner", { action: "PUT /v1/me/handle-x AAAA" }),
    ],
  ])("refuses %s", async (_case, token) => {
    const response = await send(write, token);
    expect(response.status).toBe(401);
    expect((await jsonOf(response)).error).toBe("person_grant");
  });
});

it("nothing refused changed the owner's entry", async () => {
  expect(await indexNames(market)).toContain("spade-skill/guarded-skill");
  const own = await jsonOf<{
    summary: { visibility: string; archived: boolean };
    versions: { status: string }[];
  }>(await market.fetch(entry, { headers: { authorization: `Bearer ${grantFor("acct_owner")}` } }));
  expect(own.summary).toMatchObject({ visibility: "listed", archived: false });
  expect(own.versions.map((row) => row.status)).toEqual(["not-reviewed"]);
});

it("a person's grant does its one request once: captured and sent again, it is refused", async () => {
  const body = { handle: "gate-keeper-again" };
  const grant = grantFor("acct_owner", { action: await intentOf("PUT", "/v1/me/handle", body) });
  const again = () =>
    market.fetch("/v1/me/handle", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${grant}`,
        "content-type": "application/json",
        "cf-connecting-ip": callerAddress(),
      },
      body: JSON.stringify(body),
    } as Parameters<Market["fetch"]>[1]);
  await again();
  const replayed = await again();
  expect(replayed.status).toBe(401);
  expect((await jsonOf(replayed)).error).toBe("person_grant");
});

it("a person's grant respelled in base64url is refused, so sent twice at once it still does one request", async () => {
  const body = { handle: "gate-keeper-respelled" };
  const grant = grantFor("acct_owner", { action: await intentOf("PUT", "/v1/me/handle", body) });
  const [claims = "", signature = ""] = grant.split(".");
  // Unused low bits in the signature's last character: the same bytes, another spelling.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = signature.at(-1) ?? "A";
  const respelled = `${claims}.${signature.slice(0, -1)}${alphabet[alphabet.indexOf(last) ^ 1]}`;
  const put = (token: string) =>
    market.fetch("/v1/me/handle", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "cf-connecting-ip": callerAddress(),
      },
      body: JSON.stringify(body),
    } as Parameters<Market["fetch"]>[1]);
  const [canonical, alternate] = await Promise.all([put(grant), put(respelled)]);
  expect(alternate.status).toBe(401);
  expect((await jsonOf(alternate)).error).toBe("unauthorized");
  expect(canonical.status).not.toBe(401);
  // And the canonical one, sent again, is spent.
  expect((await jsonOf(await put(grant))).error).toBe("person_grant");
});
