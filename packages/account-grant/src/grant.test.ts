import { expect, it } from "vitest";
import {
  GRANT_LIFETIME_MS,
  grantFromSubprotocols,
  grantPublicKey,
  signGrant,
  verifyGrant,
} from "./index.ts";

const key = { id: "k1", privateKey: crypto.getRandomValues(new Uint8Array(32)) };
const other = { id: "k2", privateKey: crypto.getRandomValues(new Uint8Array(32)) };
const keys = { keys: [grantPublicKey(key)] };
const claims = {
  kind: "device" as const,
  account: "user_1",
  subject: "phone",
  iat: 1_000,
  exp: 1_000 + GRANT_LIFETIME_MS,
};

it("a grant signed by a published key verifies with its claims until it expires", () => {
  const token = signGrant(claims, key);
  expect(verifyGrant(token, keys, 2_000, "device")).toMatchObject({
    account: "user_1",
    subject: "phone",
    kid: "k1",
  });
  expect(() => verifyGrant(token, keys, claims.exp, "device")).toThrow("expired");
  expect(() => verifyGrant(token, keys, 2_000, "machine")).toThrow("kind");
});

it("a grant is refused when signed by an unpublished key, altered, or issued for too long", () => {
  expect(() => verifyGrant(signGrant(claims, other), keys, 2_000, "device")).toThrow("Unknown");
  const forged = signGrant({ ...claims, kind: "device" }, { ...other, id: "k1" });
  expect(() => verifyGrant(forged, keys, 2_000, "device")).toThrow("signature");
  const [body, signature] = signGrant(claims, key).split(".");
  const altered = JSON.parse(atob(body!.replaceAll("-", "+").replaceAll("_", "/"))) as object;
  const swapped = btoa(JSON.stringify({ ...altered, account: "user_2" }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  expect(() => verifyGrant(`${swapped}.${signature}`, keys, 2_000, "device")).toThrow();
  const long = signGrant({ ...claims, exp: claims.iat + GRANT_LIFETIME_MS + 1 }, key);
  expect(() => verifyGrant(long, keys, 2_000, "device")).toThrow("lifetime");
  expect(() => verifyGrant("not a grant", keys, 2_000, "device")).toThrow("Malformed");
});

it("the grant offered among WebSocket subprotocols is found by its prefix", () => {
  expect(grantFromSubprotocols("chat, ace.grant.abc.def")).toBe("abc.def");
  expect(grantFromSubprotocols("chat")).toBeUndefined();
  expect(grantFromSubprotocols(null)).toBeUndefined();
});
