import { expect, test } from "vitest";
import { accountOrigin, hostedRelayUrl, signInReturnTo } from "./account-config.ts";

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
  expect(accountOrigin(build(true))).toBe("https://relay.acehq.dev");
  expect(hostedRelayUrl(build(true))).toBe("wss://relay.acehq.dev");
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
