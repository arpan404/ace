import { expect, it } from "vitest";
import { encodeBase64url } from "@ace/account-grant";
import { readAccountSetup } from "./config.ts";

const seed = new Uint8Array(32).fill(7);
const complete = {
  ACE_ACCOUNT_PUBLIC_URL: "https://relay.example",
  ACE_ACCOUNT_ALLOWED_ORIGINS: "https://app.example, app://ace",
  WORKOS_CLIENT_ID: "client_123456",
  WORKOS_API_KEY: "sk_live",
  ACE_ACCOUNT_ENCRYPTION_KEY: "ab".repeat(32),
  ACE_GRANT_KEY: `k2026:${encodeBase64url(seed)}`,
};

it("a Worker with no account settings runs with accounts off", () => {
  expect(readAccountSetup({})).toEqual({ status: "off" });
});

it("partial or malformed account settings fail closed instead of serving accounts", () => {
  expect(readAccountSetup({ WORKOS_CLIENT_ID: "client_partial" })).toEqual({ status: "invalid" });
  const { ACE_GRANT_KEY: _missing, ...withoutGrantKey } = complete;
  expect(readAccountSetup(withoutGrantKey)).toEqual({ status: "invalid" });
  for (const broken of [
    { ACE_GRANT_KEY: encodeBase64url(seed) },
    { ACE_GRANT_KEY: "k2026:short" },
    { ACE_ACCOUNT_ENCRYPTION_KEY: "ab" },
    { ACE_ACCOUNT_PUBLIC_URL: "http://relay.example" },
    { ACE_ACCOUNT_ALLOWED_ORIGINS: "" },
  ])
    expect(readAccountSetup({ ...complete, ...broken })).toEqual({ status: "invalid" });
});

it("complete settings publish only the grant key's public half under its id", () => {
  const setup = readAccountSetup(complete);
  if (setup.status !== "ready") throw new Error("Expected accounts on");
  expect(setup.config.allowedOrigins).toEqual(["https://app.example", "app://ace"]);
  expect(setup.config.workosUrl).toBe("https://api.workos.com");
  expect(setup.keys.keys).toHaveLength(1);
  expect(setup.keys.keys[0]?.id).toBe("k2026");
  expect(setup.keys.keys[0]?.publicKey).not.toBe(encodeBase64url(seed));
});
