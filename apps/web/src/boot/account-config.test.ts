import { expect, test } from "vitest";
import type { KeyValueStorage } from "@ace/ui-core";
import {
  accountOrigin,
  accountSessionKey,
  hostedRelayUrl,
  sameAccountOrigin,
  signInReturnTo,
  windowAccountSession,
} from "./account-config.ts";

const env = (values: Partial<ImportMetaEnv>) =>
  ({ ...import.meta.env, ...values }) as ImportMetaEnv;

test("the hosted relay is the account origin as a WebSocket address unless one is configured", () => {
  expect(hostedRelayUrl(env({ VITE_ACE_ACCOUNT_URL: "https://acehq.dev" }))).toBe(
    "wss://acehq.dev",
  );
  expect(hostedRelayUrl(env({ VITE_ACE_ACCOUNT_URL: "http://localhost:8787" }))).toBe(
    "ws://localhost:8787",
  );
  expect(
    hostedRelayUrl(
      env({
        VITE_ACE_ACCOUNT_URL: "https://acehq.dev",
        VITE_ACE_HOSTED_RELAY_URL: "wss://relay.x",
      }),
    ),
  ).toBe("wss://relay.x");
  expect(hostedRelayUrl(env({ VITE_ACE_ACCOUNT_URL: "" }))).toBeUndefined();
});

/** A build's settings without an account address: `prod` for a release build. */
function build(prod: boolean, values: Partial<ImportMetaEnv> = {}): ImportMetaEnv {
  const { VITE_ACE_ACCOUNT_URL: _unset, ...rest } = import.meta.env;
  return { ...rest, PROD: prod, ...values } as ImportMetaEnv;
}

test("a release build uses ace's own account backend unless told otherwise", () => {
  expect(accountOrigin(build(true))).toBe("https://cloud.acehq.dev");
  expect(hostedRelayUrl(build(true))).toBe("wss://cloud.acehq.dev");
  expect(accountOrigin(build(true, { VITE_ACE_ACCOUNT_URL: "https://accounts.example" }))).toBe(
    "https://accounts.example",
  );
  // Empty turns accounts off, for a build that ships without them.
  expect(accountOrigin(build(true, { VITE_ACE_ACCOUNT_URL: "" }))).toBeUndefined();
  // Development builds and tests stay account-free unless they set it.
  expect(accountOrigin(build(false))).toBeUndefined();
});

test("sign-in returns to the desktop app by its link and to a browser by its own landing page", () => {
  expect(signInReturnTo({ desktop: true, origin: "app://ace" })).toBe("ace://account/signed-in");
  expect(signInReturnTo({ desktop: false, origin: "https://app.acehq.dev" })).toBe(
    "https://app.acehq.dev/account/signed-in",
  );
  expect(signInReturnTo({ desktop: false, origin: "null" })).toBeUndefined();
});

function keyValue(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: KeyValueStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
  return { storage, values };
}
const grant = (token: string) =>
  JSON.stringify({
    token: token.repeat(43),
    account: { id: "user_a", email: "a@example.com", name: "A" },
    expiresAt: 2_000_000_000_000,
  });

test("a window signed in under ace's former address stays signed in at the current one", () => {
  const { storage, values } = keyValue({
    "ace.account.session:https://relay.acehq.dev": grant("a"),
  });
  expect(windowAccountSession(storage, "https://cloud.acehq.dev")?.token).toBe("a".repeat(43));
  expect([...values.keys()]).toEqual([accountSessionKey("https://cloud.acehq.dev")]);
});

test("a window session under ace's current address wins over one left under the former", () => {
  const { storage } = keyValue({
    "ace.account.session:https://relay.acehq.dev": grant("a"),
    "ace.account.session:https://cloud.acehq.dev": grant("b"),
  });
  expect(windowAccountSession(storage, "https://cloud.acehq.dev")?.token).toBe("b".repeat(43));
  // Another backend never takes ace's session.
  expect(windowAccountSession(storage, "https://accounts.example")).toBeNull();
});

test("a machine chosen on ace's former address is on the same backend; another backend is not", () => {
  expect(sameAccountOrigin("https://cloud.acehq.dev", "https://relay.acehq.dev")).toBe(true);
  expect(sameAccountOrigin("https://cloud.acehq.dev", "https://cloud.acehq.dev")).toBe(true);
  expect(sameAccountOrigin("https://cloud.acehq.dev", "https://accounts.example")).toBe(false);
});
