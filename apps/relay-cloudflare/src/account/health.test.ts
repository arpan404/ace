import { expect, it } from "vitest";
import { encodeBase64url } from "@ace/account-grant";
import { readAccountSetup, type AccountConfig } from "./config.ts";
import { HEALTH_REUSE_MS, workosHealth } from "./health.ts";

const goodKey = "sk_test_a1b2c3d4e5";
const goodClient = "client_01ABCDEF";

function config(apiKey: string, clientId = goodClient): AccountConfig {
  const setup = readAccountSetup({
    ACE_ACCOUNT_PUBLIC_URL: "https://relay.example",
    ACE_ACCOUNT_ALLOWED_ORIGINS: "https://app.example",
    WORKOS_CLIENT_ID: clientId,
    WORKOS_API_KEY: apiKey,
    WORKOS_API_URL: "https://workos.example",
    ACE_ACCOUNT_ENCRYPTION_KEY: "ab".repeat(32),
    ACE_GRANT_KEY: `k2026:${encodeBase64url(new Uint8Array(32).fill(7))}`,
  });
  if (setup.status !== "ready") throw new Error("test config should be ready");
  return setup.config;
}

/** WorkOS as far as the check sees it: one valid key, one known client. */
function workos(state: { up: boolean; key: string }): typeof fetch {
  return async (input, init) => {
    if (!state.up) throw new TypeError("network down");
    const url = new URL(String(input));
    if (url.pathname === "/user_management/users") {
      const auth = new Headers(init?.headers).get("Authorization");
      return new Response("{}", { status: auth === `Bearer ${state.key}` ? 200 : 401 });
    }
    if (url.pathname === `/sso/jwks/${goodClient}`) return new Response('{"keys":[]}');
    return new Response("{}", { status: 404 });
  };
}

it("a key WorkOS accepts and a client it knows read as healthy, naming no part of the key", async () => {
  const check = workosHealth(config(goodKey), workos({ up: true, key: goodKey }), () => 0);
  const health = await check();
  expect(health).toEqual({ apiKey: "accepted", keyFormat: "ok", clientId: "known" });
  expect(JSON.stringify(health)).not.toContain("a1b2");
});

it("any sk_ key WorkOS accepts reads as ok, whatever follows the prefix", async () => {
  const key = "sk_a2V5XzAxSjk5";
  const check = workosHealth(config(key), workos({ up: true, key }), () => 0);
  expect(await check()).toEqual({ apiKey: "accepted", keyFormat: "ok", clientId: "known" });
});

it("a key pasted with its setting name around it is refused and reads as unexpected", async () => {
  const pasted = `WORKOS_API_KEY= ${goodKey}`;
  const check = workosHealth(config(pasted), workos({ up: true, key: goodKey }), () => 0);
  expect(await check()).toEqual({ apiKey: "refused", keyFormat: "unexpected", clientId: "known" });
});

it("an unknown client id is told apart from a refused key", async () => {
  const check = workosHealth(
    config(goodKey, "client_01NOTREAL"),
    workos({ up: true, key: goodKey }),
    () => 0,
  );
  expect(await check()).toEqual({ apiKey: "accepted", keyFormat: "ok", clientId: "unknown" });
});

it("WorkOS out of reach reads as unreachable, never as a refused key", async () => {
  const check = workosHealth(config(goodKey), workos({ up: false, key: goodKey }), () => 0);
  expect(await check()).toEqual({
    apiKey: "unreachable",
    keyFormat: "ok",
    clientId: "unreachable",
  });
});

it("an answer is reused for half a minute, then WorkOS is asked again", async () => {
  const state = { up: true, key: goodKey };
  let time = 0;
  const check = workosHealth(config(goodKey), workos(state), () => time);
  expect((await check()).apiKey).toBe("accepted");
  state.key = "sk_test_rotated";
  time = HEALTH_REUSE_MS - 1;
  expect((await check()).apiKey).toBe("accepted");
  time = HEALTH_REUSE_MS;
  expect((await check()).apiKey).toBe("refused");
});
