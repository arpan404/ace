import { expect, test } from "vitest";
import { appInstallId, installIdentity, uuidV7 } from "./install-id.ts";

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

test("an install makes its id once and keeps it across runs", () => {
  const storage = memory();
  let made = 0;
  const make = () => uuidV7(1_700_000_000_000 + made++, new Uint8Array(10).fill(7));
  const first = appInstallId(storage, make);
  expect(appInstallId(storage, make)).toBe(first);
  expect(appInstallId(memory(Object.fromEntries(storage.values)), make)).toBe(first);
  expect(made).toBe(1);
});

test("an install that already had an account device id keeps it as its install id", () => {
  const storage = memory({ "ace.account.deviceId": "5b0f2c1e-8f43-4c55-9b1a-2d3e4f5a6b7c" });
  expect(appInstallId(storage, () => "never-used-0000")).toBe(
    "5b0f2c1e-8f43-4c55-9b1a-2d3e4f5a6b7c",
  );
});

test("a damaged install id is made again, and storage that refuses writes still yields one id", () => {
  const storage = memory({ "ace.install.id": "not valid!" });
  expect(appInstallId(storage, () => "fresh-install-1")).toBe("fresh-install-1");
  const refusing = {
    getItem: () => null,
    setItem: () => {
      throw new Error("Quota");
    },
  };
  expect(appInstallId(refusing, () => "fresh-install-2")).toBe("fresh-install-2");
});

test("every caller in one run gets the same install id when storage refuses to keep it", () => {
  const refusing = {
    getItem: () => null,
    setItem: () => {
      throw new Error("Quota");
    },
  };
  let made = 0;
  const identity = installIdentity(refusing, () =>
    uuidV7(1_700_000_000_000 + made++, new Uint8Array(10).fill(3)),
  );
  const first = identity();
  expect(identity()).toBe(first);
  expect(identity()).toBe(first);
  expect(made).toBe(1);
});

test("install ids are version 7 UUIDs ordered by the time they were made", () => {
  const random = new Uint8Array(10).fill(0xff);
  const earlier = uuidV7(1_700_000_000_000, random);
  const later = uuidV7(1_700_000_000_001, random);
  expect(earlier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(earlier < later).toBe(true);
});
