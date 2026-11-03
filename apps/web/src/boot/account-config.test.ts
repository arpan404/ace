import { expect, test } from "vitest";
import { accountDeviceId, hostedRelayUrl, signInReturnTo } from "./account-config.ts";

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

test("a browser keeps one device id for its grants, and replaces a damaged one", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  let n = 0;
  const id = () => `device-${++n}-aaaaaaaa`;
  const first = accountDeviceId(storage, id);
  expect(accountDeviceId(storage, id)).toBe(first);
  values.set("ace.account.deviceId", "not valid!");
  expect(accountDeviceId(storage, id)).toBe("device-2-aaaaaaaa");
});

test("sign-in returns to the desktop app by its link and to a browser by its own landing page", () => {
  expect(signInReturnTo({ desktop: true, origin: "app://ace" })).toBe("ace://account/signed-in");
  expect(signInReturnTo({ desktop: false, origin: "https://app.acehq.dev" })).toBe(
    "https://app.acehq.dev/account/signed-in",
  );
  expect(signInReturnTo({ desktop: false, origin: "null" })).toBeUndefined();
});
