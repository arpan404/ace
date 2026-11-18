import { describe, expect, test } from "vitest";
import { DeviceId, HostId, type FleetLink } from "@ace/protocol";
import { allowProjectsOffer, transferMachines } from "./transfers.ts";

const link = (extra: Partial<FleetLink>): FleetLink => ({
  hostId: HostId.parse("laptop"),
  profile: "laptop",
  name: "Old laptop",
  origin: "https://laptop.local:5870/",
  deviceId: DeviceId.parse("mac-on-laptop"),
  status: "online",
  access: "operate",
  ...extra,
});

test("a machine that doesn't allow projects stays listed, naming the link to widen", () => {
  expect(transferMachines([link({ projects: false })])).toEqual([
    {
      hostId: "laptop",
      name: "Old laptop",
      deviceId: "mac-on-laptop",
      reason: "Projects not allowed",
    },
  ]);
});

const linkDevice = { id: "mac-on-laptop", scopes: ["read", "operate"] as const };
const offer = (devices: Parameters<typeof allowProjectsOffer>[0]["devices"], reached = true) =>
  allowProjectsOffer({ reached, deviceId: "mac-on-laptop", devices });

describe("choosing a machine that doesn't allow projects", () => {
  test("offers allowing them when this window is an administrator there holding Projects", () => {
    expect(offer([linkDevice, { id: "me", scopes: ["admin", "projects"], self: true }])).toBe(
      "allow",
    );
  });

  test("offers allowing them from that machine's own app, which isn't a paired device", () => {
    expect(offer([linkDevice])).toBe("allow");
  });

  test("sends an administrator without Projects to Settings, since it can't grant them", () => {
    expect(offer([linkDevice, { id: "me", scopes: ["admin"], self: true }])).toBe("settings");
  });

  test("sends a window that can't manage that machine, or doesn't reach it, to Settings", () => {
    expect(offer("refused")).toBe("settings");
    expect(offer([linkDevice], false)).toBe("settings");
  });

  test("sends to Settings when the link's device is gone there", () => {
    expect(offer([{ id: "me", scopes: ["admin", "projects"], self: true }])).toBe("settings");
  });

  test("waits while that machine's devices are read", () => {
    expect(offer("pending")).toBe("checking");
  });
});
