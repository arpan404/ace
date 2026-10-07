import { afterEach, expect, test } from "vitest";
import { cleanup, poolWorld, paired, wait, create } from "./machines-process.fixture.ts";
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
test("independent machines survive simultaneous worker replacement", async () => {
  const f = poolWorld();
  const hosts = Array.from({ length: 16 }, (_, index) => `host-${index}`);
  await Promise.all(hosts.map((host) => f.pool.add(paired(host))));
  for (let round = 0; round < 16; round++) {
    await Promise.all(
      hosts.map((host) => wait(f.pool.status(host), (state) => state?.status === "online", 30000)),
    );
    await Promise.all(
      hosts.map(async (host) =>
        expect(await f.pool.create(host, create(`thread-${round}`))).toMatchObject({ ok: true }),
      ),
    );
    await Promise.all(hosts.map((host) => f.workers.get(host)?.terminate()));
    await Promise.all(
      hosts.map((host) => wait(f.pool.status(host), (state) => state?.status === "offline", 30000)),
    );
    for (const host of hosts) f.pool.reconnect(host);
  }
  await Promise.all(
    hosts.map((host) => wait(f.pool.status(host), (state) => state?.status === "online", 30000)),
  );
});
