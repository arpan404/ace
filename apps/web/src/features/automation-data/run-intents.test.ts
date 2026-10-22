import { expect, test } from "vitest";
import {
  clearRunIntent,
  ensureRunIntent,
  getRunIntent,
  maxRunIntents,
  normalizeDaemonKey,
} from "./run-intents.ts";
function memoryKeyValue() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

test("one intent per daemon per automation survives reloads and clears once answered", () => {
  const storage = memoryKeyValue();
  const daemon = normalizeDaemonKey("memory://fake-daemon");
  const first = ensureRunIntent(
    storage,
    daemon,
    "auto-a",
    () => 1000,
    () => "req-1",
  );
  expect(first?.requestId).toBe("req-1");
  const again = ensureRunIntent(
    storage,
    daemon,
    "auto-a",
    () => 2000,
    () => "req-2",
  );
  expect(again?.requestId).toBe("req-1");
  expect(getRunIntent(storage, daemon, "auto-a")?.requestId).toBe("req-1");
  expect(getRunIntent(storage, normalizeDaemonKey("other://daemon"), "auto-a")).toBeUndefined();
  const other = ensureRunIntent(
    storage,
    normalizeDaemonKey("other://daemon"),
    "auto-a",
    () => 3000,
    () => "req-3",
  );
  expect(other?.requestId).toBe("req-3");
  clearRunIntent(storage, daemon, "auto-a");
  expect(getRunIntent(storage, daemon, "auto-a")).toBeUndefined();
  expect(getRunIntent(storage, normalizeDaemonKey("other://daemon"), "auto-a")?.requestId).toBe(
    "req-3",
  );
});

test("a full store refuses new intents instead of evicting unresolved ones", () => {
  const storage = memoryKeyValue();
  const daemon = normalizeDaemonKey("memory://fake-daemon");
  for (let index = 0; index < maxRunIntents; index++)
    expect(
      ensureRunIntent(
        storage,
        daemon,
        `auto-${index}`,
        () => index,
        () => `req-${index}`,
      )?.requestId,
    ).toBe(`req-${index}`);
  expect(
    ensureRunIntent(
      storage,
      daemon,
      "auto-overflow",
      () => 999,
      () => "req-new",
    ),
  ).toBeUndefined();
  expect(getRunIntent(storage, daemon, "auto-0")?.requestId).toBe("req-0");
});

test("memory-only storage refuses a run whose retry key would disappear on reload", () => {
  const storage = { ...memoryKeyValue(), durable: false };
  const daemon = normalizeDaemonKey("memory://fake-daemon");
  expect(
    ensureRunIntent(
      storage,
      daemon,
      "auto-a",
      () => 1,
      () => "req-1",
    ),
  ).toBeUndefined();
  expect(getRunIntent(storage, daemon, "auto-a")).toBeUndefined();
});

test("a blocked store refuses dispatch and daemon keys strip credentials and queries", () => {
  const secret = "secret-token-abc123";
  const dirty = `ws://user:${secret}@host:4242/some/path?foo=bar&token=${secret}#token=${secret}`;
  const clean = normalizeDaemonKey(dirty);
  expect(clean).not.toContain(secret);
  expect(clean).not.toContain("foo=bar");
  expect(clean).not.toContain("user@");
  expect(clean).toBe(normalizeDaemonKey("ws://host:4242/some/path"));
  const blocked = {
    data: new Map<string, string>(),
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {},
  };
  expect(
    ensureRunIntent(
      blocked,
      clean,
      "auto-a",
      () => 1,
      () => "req-1",
    ),
  ).toBeUndefined();
});
