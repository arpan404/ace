import { expect, test } from "vitest";
import { grantCache, grantReuseMarginMs } from "./grant-cache.ts";

const lifeMs = 300_000;

function backend() {
  let now = 0;
  let issued = 0;
  const asked: string[] = [];
  let failNext = false;
  const grants = grantCache(
    async (session) => {
      asked.push(session);
      if (failNext) {
        failNext = false;
        throw new Error("backend down");
      }
      return { token: `grant-${++issued}`, expiresAt: now + lifeMs };
    },
    () => now,
  );
  return {
    grants,
    asked,
    advance: (ms: number) => (now += ms),
    failOnce: () => (failNext = true),
  };
}

test("every path of a race shares one grant fetch", async () => {
  const b = backend();
  const tokens = await Promise.all([b.grants("s"), b.grants("s"), b.grants("s")]);
  expect(tokens).toEqual(["grant-1", "grant-1", "grant-1"]);
  expect(b.asked).toEqual(["s"]);
});

test("a reconnect within the grant's life reuses it, and one near its end fetches anew", async () => {
  const b = backend();
  await b.grants("s");
  b.advance(lifeMs - grantReuseMarginMs - 1);
  expect(await b.grants("s")).toBe("grant-1");
  b.advance(2);
  expect(await b.grants("s")).toBe("grant-2");
  expect(b.asked).toHaveLength(2);
});

test("another ace session never gets the last session's grant", async () => {
  const b = backend();
  expect(await b.grants("a")).toBe("grant-1");
  expect(await b.grants("b")).toBe("grant-2");
});

test("a failed fetch is not kept: the next connect asks again", async () => {
  const b = backend();
  b.failOnce();
  await expect(b.grants("s")).rejects.toThrow("backend down");
  expect(await b.grants("s")).toBe("grant-1");
});
