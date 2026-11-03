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

it("during a rotation the replaced key is published after the signing key", () => {
  const signing = readAccountSetup(complete);
  if (signing.status !== "ready") throw new Error("Expected accounts on");
  const previous = `k2025:${signing.keys.keys[0]?.publicKey}`;
  const rotated = readAccountSetup({
    ...complete,
    ACE_GRANT_KEY: `k2027:${encodeBase64url(new Uint8Array(32).fill(9))}`,
    ACE_GRANT_PREVIOUS_KEY: previous,
  });
  if (rotated.status !== "ready") throw new Error("Expected accounts on");
  expect(rotated.keys.keys.map((key) => key.id)).toEqual(["k2027", "k2025"]);
  expect(rotated.keys.keys[1]?.publicKey).toBe(signing.keys.keys[0]?.publicKey);
  // Removing it (or leaving it empty) publishes the signing key alone again.
  const done = readAccountSetup({ ...complete, ACE_GRANT_PREVIOUS_KEY: "" });
  expect(done.status === "ready" && done.keys.keys.map((key) => key.id)).toEqual(["k2026"]);
});

it("a malformed previous key fails closed", () => {
  for (const previous of ["k2025", `k2025:${"A".repeat(44)}`, `k 2025:${"A".repeat(43)}`])
    expect(readAccountSetup({ ...complete, ACE_GRANT_PREVIOUS_KEY: previous })).toEqual({
      status: "invalid",
    });
});

it("a previous key set before the new signing key arrives changes nothing yet", () => {
  // Step one of a rotation: the previous key names the key still signing.
  const setup = readAccountSetup({
    ...complete,
    ACE_GRANT_PREVIOUS_KEY: `k2026:${"A".repeat(43)}`,
  });
  const before = readAccountSetup(complete);
  if (setup.status !== "ready" || before.status !== "ready")
    throw new Error("Expected accounts on");
  expect(setup.keys).toEqual(before.keys);
});
