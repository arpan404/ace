import { expect, it } from "vitest";
import {
  CloudGrantClaims,
  decodeBase64url,
  grantPublicKey,
  verifyGrant,
  verifyMarketGrant,
} from "@ace/account-grant";
import { AceGrantResponse } from "@ace/protocol/ace-account";
import { hostId, keyPair } from "@ace/secure-channel";
import { readAccountSetup } from "./config.ts";
import { admit } from "../admission.ts";
import { encodeBase64url, GRANT_SUBPROTOCOL_PREFIX } from "@ace/account-grant";
import { directoryRoutes } from "./directory.ts";

const unused = async (): Promise<never> => {
  throw new Error("grant issuance must not touch the machine directory");
};

it("the account backend signs a cloud credential that cannot authorize a relay host", async () => {
  const signingKey = { id: "cloud-test", privateKey: new Uint8Array(32).fill(7) };
  const publicKey = grantPublicKey(signingKey);
  const keys = { keys: [publicKey] };
  const routes = directoryRoutes({
    principals: {
      read: async (token) =>
        token === "s".repeat(43)
          ? {
              kind: "session",
              hash: "h",
              account: { id: "alice", email: "alice@example.com", name: "Alice" },
              expiresAt: 999999,
              signedInAt: 900,
              standing: "person",
            }
          : undefined,
      revoke: unused,
    },
    sessionStore: { expose: async () => {}, standingNow: async () => "person" as const },
    machines: { register: unused, seen: unused, list: unused, forget: unused },
    keys,
    signingKey,
    now: () => 1000,
  });
  const subject = hostId(keyPair().publicKey);
  const request = (purpose: string) =>
    new Request("https://relay.acehq.dev/v1/grants", {
      method: "POST",
      headers: { authorization: `Bearer ${"s".repeat(43)}` },
      body: JSON.stringify({ kind: "machine", subject, purpose }),
    });
  const response = await routes.grant(request("spade-cloud"));
  expect(response.status).toBe(200);
  const { token } = AceGrantResponse.parse(await response.json());
  const [body = "", signature = ""] = token.split(".");
  const claims = CloudGrantClaims.parse(
    JSON.parse(new TextDecoder().decode(decodeBase64url(body))),
  );
  expect(claims).toMatchObject({
    account: "alice",
    aud: "cloud.acehq.dev",
    purpose: "spade-cloud",
  });
  const verificationKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(decodeBase64url(publicKey.publicKey)),
    "Ed25519",
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      "Ed25519",
      verificationKey,
      new Uint8Array(decodeBase64url(signature)),
      new Uint8Array(decodeBase64url(body)),
    ),
  ).toBe(true);
  expect(() => verifyGrant(token, keys, 2000, "machine")).toThrow();
  const setup = readAccountSetup({
    ACE_ACCOUNT_PUBLIC_URL: "https://relay.acehq.dev",
    ACE_ACCOUNT_ALLOWED_ORIGINS: "app://ace",
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_API_KEY: "test-key",
    ACE_ACCOUNT_ENCRYPTION_KEY: "a".repeat(64),
    ACE_GRANT_KEY: `${signingKey.id}:${encodeBase64url(signingKey.privateKey)}`,
  });
  expect(setup.status).toBe("ready");
  expect(
    admit({
      endpoint: "/host",
      hostId: subject,
      subprotocols: GRANT_SUBPROTOCOL_PREFIX + token,
      setup,
      now: 2000,
    }),
  ).toEqual({ admitted: false, status: 401 });
  expect((await routes.grant(request("other-service"))).status).toBe(400);
});

async function marketGrantFor(emailVerified: boolean) {
  const signingKey = { id: "cloud-test", privateKey: new Uint8Array(32).fill(7) };
  const keys = { keys: [grantPublicKey(signingKey)] };
  const routes = directoryRoutes({
    principals: {
      read: async () => ({
        kind: "session",
        hash: "h",
        account: { id: "alice", email: "alice@example.com", name: "Alice", emailVerified },
        expiresAt: 999999,
        signedInAt: 900,
        standing: "person",
      }),
      revoke: unused,
    },
    sessionStore: { expose: unused, standingNow: async () => "person" as const },
    machines: { register: unused, seen: unused, list: unused, forget: unused },
    keys,
    signingKey,
    now: () => 1000,
  });
  const response = await routes.grant(
    new Request("https://cloud.acehq.dev/v1/grants", {
      method: "POST",
      headers: { authorization: `Bearer ${"s".repeat(43)}` },
      body: JSON.stringify({ kind: "device", subject: "laptop", purpose: "market-publish" }),
    }),
  );
  return { response, keys };
}

it("the account backend signs a market publishing grant for a device that only the market accepts", async () => {
  const { response, keys } = await marketGrantFor(true);
  expect(response.status).toBe(200);
  const { token } = AceGrantResponse.parse(await response.json());
  expect(verifyMarketGrant(token, keys, 2000)).toMatchObject({
    account: "alice",
    aud: "market.acehq.dev",
    iss: "cloud.acehq.dev",
    emailVerified: true,
    authAt: 900,
  });
  expect(() => verifyGrant(token, keys, 2000, "device")).toThrow();
});

it("the account backend refuses a market publishing grant to an account whose email isn't verified", async () => {
  const { response } = await marketGrantFor(false);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: "email_unverified" });
});

it("a session signed out or retired after it was read gets no grant, in any format", async () => {
  const signingKey = { id: "cloud-test", privateKey: new Uint8Array(32).fill(7) };
  const routes = directoryRoutes({
    principals: {
      read: async () => ({
        kind: "session",
        hash: "h",
        account: { id: "alice", email: "alice@example.com", name: "Alice" },
        expiresAt: 999999,
        signedInAt: 900,
        standing: "person",
      }),
      revoke: unused,
    },
    // Gone by the time the grant is decided.
    sessionStore: { expose: async () => {}, standingNow: async () => undefined },
    machines: { register: unused, seen: unused, list: unused, forget: unused },
    keys: { keys: [grantPublicKey(signingKey)] },
    signingKey,
    now: () => 1000,
  });
  const response = await routes.grant(
    new Request("https://cloud.acehq.dev/v1/grants", {
      method: "POST",
      headers: { authorization: `Bearer ${"s".repeat(43)}` },
      body: JSON.stringify({ kind: "device", subject: "phone" }),
    }),
  );
  expect(response.status).toBe(401);
});
