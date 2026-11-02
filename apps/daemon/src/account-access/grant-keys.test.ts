import { expect, it } from "vitest";
import { grantPublicKey, signGrant, type GrantKeySet } from "@ace/account-grant";
import { KEY_REFETCH_MS, grantKeyCache } from "./grant-keys.ts";

const signingKey = (id: string, fill: number) => ({
  id,
  privateKey: new Uint8Array(32).fill(fill),
});
const grantFrom = (key: ReturnType<typeof signingKey>) =>
  signGrant({ kind: "device", account: "a", subject: "d", iat: 0, exp: 60_000 }, key);

function backend(initial: GrantKeySet) {
  let published = initial;
  let fetches = 0;
  return {
    publish(next: GrantKeySet) {
      published = next;
    },
    get fetches() {
      return fetches;
    },
    fetchKeys: async () => {
      fetches++;
      return published;
    },
  };
}

it("keys are fetched once and reused while grants name a known key", async () => {
  const k1 = signingKey("k1", 1);
  const server = backend({ keys: [grantPublicKey(k1)] });
  const cache = grantKeyCache({ fetchKeys: server.fetchKeys, now: () => 0 });
  await cache.forGrant(grantFrom(k1));
  await cache.forGrant(grantFrom(k1));
  expect(server.fetches).toBe(1);
});

it("a rotated key is fetched once, and a key id that stays unknown is not fetched again", async () => {
  const k1 = signingKey("k1", 1);
  const k2 = signingKey("k2", 2);
  const k3 = signingKey("k3", 3);
  let now = 0;
  const server = backend({ keys: [grantPublicKey(k1)] });
  const cache = grantKeyCache({ fetchKeys: server.fetchKeys, now: () => now });
  await cache.forGrant(grantFrom(k1));
  now += KEY_REFETCH_MS;
  server.publish({ keys: [grantPublicKey(k1), grantPublicKey(k2)] });
  expect((await cache.forGrant(grantFrom(k2))).keys.map((key) => key.id)).toEqual(["k1", "k2"]);
  expect(server.fetches).toBe(2);
  now += KEY_REFETCH_MS;
  await cache.forGrant(grantFrom(k3));
  await cache.forGrant(grantFrom(k3));
  expect(server.fetches).toBe(3);
});

it("unknown key ids cannot make the daemon refetch more than once a minute", async () => {
  const k1 = signingKey("k1", 1);
  let now = 0;
  const server = backend({ keys: [grantPublicKey(k1)] });
  const cache = grantKeyCache({ fetchKeys: server.fetchKeys, now: () => now });
  await cache.forGrant(grantFrom(k1));
  for (let index = 0; index < 20; index++)
    await cache.forGrant(grantFrom(signingKey(`x${index}`, 10 + index)));
  expect(server.fetches).toBe(1);
  now += KEY_REFETCH_MS;
  await cache.forGrant(grantFrom(signingKey("late", 99)));
  expect(server.fetches).toBe(2);
});
