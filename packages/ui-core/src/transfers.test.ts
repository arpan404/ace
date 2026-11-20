import { describe, expect, test } from "vitest";
import { DeviceId, HostId, type FleetLink } from "@ace/protocol";
import {
  allowProjectsOffer,
  allowProjectsWords,
  scopeChangeRefusal,
  transferMachines,
} from "./transfers.ts";

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

  test("doesn't offer Projects to a link that may only view there, since it couldn't take work", () => {
    const viewOnly = { id: "mac-on-laptop", scopes: ["read"] as const };
    expect(
      allowProjectsOffer({ reached: true, deviceId: "mac-on-laptop", devices: [viewOnly] }),
    ).toBe("viewOnly");
  });

  test("goes on when the link already holds both, whatever the picker read earlier", () => {
    const both = { id: "mac-on-laptop", scopes: ["read", "operate", "projects"] as const };
    expect(allowProjectsOffer({ reached: true, deviceId: "mac-on-laptop", devices: [both] })).toBe(
      "held",
    );
  });
});

test("a machine too old to change a link's scopes says to update it or link again", () => {
  expect(scopeChangeRefusal("invalid_message", "Old laptop")).toMatch(
    /^Old laptop runs an older ace .* Update ace there, or unlink and link them again/,
  );
  expect(scopeChangeRefusal("forbidden", "Old laptop")).toBeUndefined();
});

const allowWords = (shown: Parameters<typeof allowProjectsWords>[0]["offer"], refused?: string) =>
  allowProjectsWords({ offer: shown, machine: "Studio", sender: "MacBook", refused });

test("the Allow projects step says in one sentence what stands between the two machines", () => {
  expect(allowWords("allow")).toBe("Studio doesn't take projects from MacBook yet.");
  expect(allowWords("settings")).toBe(
    "Studio doesn't take projects from MacBook yet; allow them on Studio in Settings › Fleet.",
  );
  expect(allowWords("viewOnly")).toBe(
    "MacBook's link can only view on Studio, so it can't take projects; unlink and link them again in Settings › Fleet.",
  );
  expect(allowWords("held")).toBe("Studio takes projects from MacBook now.");
  // An older ace there can't parse the change: update it, whatever the offer was.
  expect(allowWords("allow", "invalid_message")).toBe(
    scopeChangeRefusal("invalid_message", "Studio"),
  );
});
