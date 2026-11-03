import { expect, it } from "vitest";
import { devicesRoute } from "./devices-route.ts";

const hostId = "A".repeat(52);

it("a machine paired through a relay reaches its devices only through the pinned relay channel", () => {
  expect(
    devicesRoute({ url: "wss://relay.example.com", pairedDeviceId: "phone", relayHostId: hostId }),
  ).toEqual({ kind: "relay", url: "wss://relay.example.com", hostId });
});

it("a paired machine elsewhere is tried at its own address before its relay", () => {
  expect(devicesRoute({ url: "wss://studio.tail.ts.net:7777", pairedDeviceId: "phone" })).toEqual({
    kind: "direct-then-relay",
  });
});

it("this computer's daemon and unpaired targets use their own address only", () => {
  expect(devicesRoute({ url: "ws://127.0.0.1:7777", pairedDeviceId: "phone" })).toEqual({
    kind: "direct",
  });
  expect(devicesRoute({ url: "wss://studio.tail.ts.net:7777" })).toEqual({ kind: "direct" });
});
