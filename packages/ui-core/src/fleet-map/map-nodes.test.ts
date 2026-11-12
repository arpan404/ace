import { expect, test } from "vitest";
import { deviceNode } from "./map-nodes.ts";
import type { FleetMapInput, MapDeviceInput } from "./map-types.ts";

const off = { state: "off" } as const;
const studio: FleetMapInput = {
  own: { id: "studio", name: "studio", online: true, working: undefined },
  enabled: true,
  networks: { lan: off, tailscale: off, relay: off, account: off },
  relayHost: undefined,
  machines: [],
  account: [],
  devices: [],
  links: [],
  now: 1_000,
};
const ipad: MapDeviceInput = {
  key: "iPad",
  name: "iPad",
  on: ["studio"],
  lastSeenAt: 500,
  expiresAt: null,
  self: false,
  readOnly: false,
};
const names = (id: string) => id;

test("a device judged against a named machine says that machine, not this computer", () => {
  const node = deviceNode(ipad, studio, names, { name: "studio", here: "on studio" });
  expect(node.problem?.what).toBe(
    "iPad was paired with a code, and the networks paired devices use are off on studio.",
  );
  expect(node.problem?.why).toMatch(/^Paired devices reach studio over/);
  const shut = deviceNode(ipad, { ...studio, enabled: false }, names, {
    name: "studio",
    here: "on studio",
  });
  expect(shut.problem?.what).toBe("iPad can't reach studio: remote access is off.");
});

test("without a place, a device is judged against this computer", () => {
  expect(deviceNode(ipad, { ...studio, enabled: false }, names).problem?.what).toBe(
    "iPad can't reach this computer: remote access is off.",
  );
});
