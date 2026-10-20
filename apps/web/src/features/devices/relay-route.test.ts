import { expect, test } from "vitest";
import type { RemoteAccessStatus } from "@ace/protocol";
import { learnRelay, rememberedRelay } from "./relay-route.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const url = "wss://office.example:4243/";
const route = { url: "wss://relay.example/", fingerprint: "A".repeat(52), hostId: "office" };
const unreachable = async (): Promise<RemoteAccessStatus> => {
  throw new TypeError("Failed to fetch");
};
const status = (relay?: typeof route): RemoteAccessStatus => ({
  enabled: true,
  transport: relay ? "relay" : "lan",
  listenOverride: null,
  relayOverride: false,
  ...(relay ? { relay } : {}),
});

test("a relay the daemon advertised is still known when the daemon can't be asked", async () => {
  const store = storage();
  expect(await learnRelay(store, url, async () => status(route))).toEqual(route);
  expect(await learnRelay(store, url, unreachable)).toEqual(route);
  // Another daemon's address has no route.
  expect(rememberedRelay(store, "wss://other.example/")).toBeUndefined();
});

test("a daemon that turned its relay off forgets the route", async () => {
  const store = storage();
  await learnRelay(store, url, async () => status(route));
  expect(await learnRelay(store, url, async () => status())).toBeUndefined();
  expect(rememberedRelay(store, url)).toBeUndefined();
});

test("a damaged remembered route is no route", () => {
  const store = storage();
  store.setItem(`ace.devices.relay:${url}`, "{not json");
  expect(rememberedRelay(store, url)).toBeUndefined();
  store.setItem(`ace.devices.relay:${url}`, JSON.stringify({ ...route, fingerprint: "short" }));
  expect(rememberedRelay(store, url)).toBeUndefined();
});
