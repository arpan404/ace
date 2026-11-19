import { expect, test } from "vitest";
import { loadTarget, saveTarget } from "./connection-settings.ts";

function store() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

const relayHostId = "R".repeat(52);
const token = "a".repeat(64);

test("a window paired through a relay reconnects through the same relay after a reload", () => {
  const stores = { local: store(), session: store() };
  saveTarget(
    stores,
    { url: "wss://relay.example.com/", token, pairedDeviceId: "phone", relayHostId },
    true,
  );
  expect(loadTarget(stores).target).toEqual({
    url: "wss://relay.example.com/",
    token,
    pairedDeviceId: "phone",
    relayHostId,
  });
});

test("connecting directly afterwards forgets the relay", () => {
  const stores = { local: store(), session: store() };
  saveTarget(stores, { url: "wss://relay.example.com/", token, relayHostId }, true);
  saveTarget(stores, { url: "ws://127.0.0.1:4242/", token }, true);
  expect(loadTarget(stores).target?.relayHostId).toBeUndefined();
});
