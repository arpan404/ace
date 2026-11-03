import { expect, test } from "vitest";
import { accountSettings } from "./config.ts";

test("a daemon signs in to ace's own backend and grants only ace's relay unless told otherwise", () => {
  expect(accountSettings(undefined, undefined)).toEqual({
    accountOrigin: "https://relay.acehq.dev",
    hostedRelayUrl: "wss://relay.acehq.dev",
  });
});

test("a named backend brings its own relay host; a named relay wins over both", () => {
  expect(accountSettings("https://accounts.example", undefined)).toEqual({
    accountOrigin: "https://accounts.example",
    hostedRelayUrl: "wss://accounts.example",
  });
  expect(accountSettings("http://127.0.0.1:8787", undefined).hostedRelayUrl).toBe(
    "ws://127.0.0.1:8787",
  );
  expect(accountSettings("https://accounts.example", "wss://relay.example/").hostedRelayUrl).toBe(
    "wss://relay.example/",
  );
});
