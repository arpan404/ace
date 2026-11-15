import { expect, test } from "vitest";
import { raceStagger } from "./path-plan.ts";
import { connected, settle } from "./path-switch.fixture.ts";

test.each([
  ["nothing measured", undefined, 150],
  ["a fast LAN win", 40, 150],
  ["a 1 s win", 1_000, 1_500],
  ["a 3 s relay win", 3_000, 2_000],
])("after %s the next path waits its stagger", (_name, lastOpenMs, staggerMs) => {
  expect(raceStagger(lastOpenMs)).toBe(staggerMs);
});

test("after a slow relay win, the next race gives the relay longer before dialing the LAN too", async () => {
  const { clock, client, path } = await connected("relay", ["relay", "lan"], {
    // The LAN is out of reach, and the relay takes a second to open.
    prepare: (each) => {
      if (each.kind === "lan") each.up = false;
      if (each.kind === "relay") each.held = true;
    },
    ready: false,
  });
  const relay = path("relay");
  const lan = path("lan");
  clock.advance(1_000);
  relay.release();
  await settle();
  expect(client.state).toBe("ready");
  // Back home, the LAN answers again; the relay drops and is slow again.
  lan.up = true;
  relay.held = true;
  const lanBefore = lan.sockets.length;
  relay.last.drop();
  await settle();
  for (let step = 0; step < 100 && relay.sockets.length < 2; step++) {
    clock.advance(50);
    await settle();
  }
  expect(relay.sockets).toHaveLength(2);
  // A fixed 150 ms stagger would have dialed the LAN by now.
  clock.advance(1_000);
  await settle();
  expect(lan.sockets).toHaveLength(lanBefore);
  clock.advance(600);
  await settle();
  expect(lan.sockets).toHaveLength(lanBefore + 1);
});
