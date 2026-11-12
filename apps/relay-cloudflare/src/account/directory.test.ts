import { expect, it } from "vitest";
import { CloudGrantClaims, decodeBase64url, grantPublicKey, verifyGrant } from "@ace/account-grant";
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
    sessions: {
      read: async (token) =>
        token === "s".repeat(43)
          ? {
              account: { id: "alice", email: "alice@example.com", name: "Alice" },
              expiresAt: 999999,
            }
          : undefined,
      revoke: unused,
    },
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
      body: JSON.stringify({
        kind: "machine",
        subject,
        purpose,
      }),
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
