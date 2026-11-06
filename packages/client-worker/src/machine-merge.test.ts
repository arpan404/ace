import { afterEach, expect, test } from "vitest";
import {
  browserPairing,
  closePools,
  fingerprint,
  lan,
  relayKey,
  until,
  world,
} from "./machine-merge.fixture.ts";

afterEach(closePools);

test("an account machine whose relay is out of reach takes the direct route once the app pairs it, listed once", async () => {
  const f = world();
  await f.pool.start();
  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  await until(() => f.pool.machine(relayKey)?.status !== "connecting");
  expect(f.pool.machine(relayKey)?.status).not.toBe("online");

  await f.pool.add({
    ...browserPairing,
    target: { kind: "direct", url: "wss://192.168.1.4:7443/", fingerprint },
  });
  // The pairing said over its connection that ace's relay knows it by `relayKey`: one machine.
  await until(() => f.pool.machine(relayKey)?.status === "online");
  expect(f.pool.ids).toEqual([relayKey]);
  expect(f.pool.machine(relayKey)?.path).toBe("lan");
  expect(f.directDialed).toContain(lan);
});

test("a machine paired in a browser and opened through the account keeps the LAN route it was paired at", async () => {
  const f = world();
  await f.pool.start();
  await f.pool.add(browserPairing);
  await until(() => f.pool.machine("host")?.status === "online");
  await until(() => (f.directory.machines[0]?.paths?.length ?? 0) > 0);

  f.pool.openAccountMachine({ hostId: relayKey, name: "Office Mac" });
  expect(f.pool.ids).toEqual([relayKey]);
  // The paired connection stepped aside; the account entry reaches the same daemon on the LAN.
  await until(() => f.pool.machine(relayKey)?.status === "online");
  expect(f.pool.machine(relayKey)?.path).toBe("lan");
});
