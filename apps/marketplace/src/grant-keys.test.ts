import { describe, expect, it } from "vitest";
import { configuredKeys, fetchedKeys } from "./grant-keys.ts";

const keys = { keys: [{ id: "k1", publicKey: "A".repeat(43) }] };
const other = { keys: [{ id: "k2", publicKey: "B".repeat(43) }] };

function backend(bodies: unknown[]) {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      const body = bodies.shift();
      if (body instanceof Error) throw body;
      return new Response(JSON.stringify(body), { status: body === undefined ? 503 : 200 });
    },
  };
}

describe("grant keys", () => {
  it("reads configured keys, and none from text that isn't a key set", async () => {
    expect(await configuredKeys(JSON.stringify(keys)).get()).toEqual(keys);
    expect(await configuredKeys("{").get()).toBeUndefined();
  });

  it("fetches the backend's keys once per lifetime, then again", async () => {
    let now = 0;
    const fake = backend([keys, other]);
    const source = fetchedKeys({
      url: "https://keys.test/v1/keys",
      fetch: fake.fetch,
      now: () => now,
      ttlMs: 1000,
    });
    expect(await source.get()).toEqual(keys);
    now = 999;
    expect(await source.get()).toEqual(keys);
    expect(fake.calls).toHaveLength(1);
    now = 1000;
    expect(await source.get()).toEqual(other);
  });

  it("keeps the last keys while the backend can't be reached, and has none before the first", async () => {
    let now = 0;
    const fake = backend([new Error("offline"), keys, undefined, new Error("offline")]);
    const source = fetchedKeys({
      url: "https://keys.test/v1/keys",
      fetch: fake.fetch,
      now: () => now,
      ttlMs: 10,
    });
    expect(await source.get()).toBeUndefined();
    expect(await source.get()).toEqual(keys);
    now = 20;
    expect(await source.get()).toEqual(keys);
    expect(await source.get()).toEqual(keys);
  });
});
